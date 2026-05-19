import { useCallback, useEffect, useMemo, useState } from 'react'
import { getSupabaseClient, isSupabaseConfigured } from './lib/supabase.js'

const incomeCategories = ['Salary', 'Freelance', 'Business', 'Gift', 'Investment', 'Other Income']
const expenseCategories = ['Food', 'Transport', 'Bills', 'Rent', 'Shopping', 'Health', 'Education', 'Family', 'Savings', 'Other Expense']
const today = new Date().toISOString().slice(0, 10)
const currentMonth = today.slice(0, 7)
const defaultBudget = 50000
const spaceStorageKey = 'pkr-budget-space-id'

const pkrFormatter = new Intl.NumberFormat('en-PK', {
  style: 'currency',
  currency: 'PKR',
  maximumFractionDigits: 0
})

function formatPKR(value) {
  return pkrFormatter.format(Number(value || 0))
}

function cleanNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function getMonthRange(month) {
  const [year, monthIndex] = month.split('-').map(Number)
  const start = `${month}-01`
  const next = new Date(Date.UTC(year, monthIndex, 1))
  const end = next.toISOString().slice(0, 10)
  return { start, end }
}

function normalizeSpaceId(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 24)
}

function makeSpaceId() {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 8) || String(Date.now()).slice(-8)
  return `PKR-${random.toUpperCase()}`
}

function readJson(key, fallback = null) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // The app still works online if browser storage is unavailable.
  }
}

function getInitialSpaceId() {
  const existing = normalizeSpaceId(localStorage.getItem(spaceStorageKey))
  if (existing) return existing
  const next = makeSpaceId()
  localStorage.setItem(spaceStorageKey, next)
  return next
}

export default function App() {
  const [spaceId, setSpaceId] = useState(getInitialSpaceId)
  const [transactions, setTransactions] = useState([])
  const [monthlyBudget, setMonthlyBudget] = useState(defaultBudget)
  const [selectedMonth, setSelectedMonth] = useState(currentMonth)
  const [activeTab, setActiveTab] = useState('overview')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [syncText, setSyncText] = useState(isSupabaseConfigured ? 'Syncing...' : 'Local mode')
  const [filter, setFilter] = useState('all')
  const [showAdd, setShowAdd] = useState(false)

  const cacheKey = `pkr-budget-cache:${spaceId}:${selectedMonth}`
  const settingsKey = `pkr-budget-settings:${spaceId}`

  const loadData = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true)
    setError('')

    if (!isSupabaseConfigured) {
      const localData = readJson(cacheKey, { transactions: [] })
      const localSettings = readJson(settingsKey, { monthlyBudget: defaultBudget })
      setTransactions(localData.transactions || [])
      setMonthlyBudget(Number(localSettings.monthlyBudget || defaultBudget))
      setSyncText('Local only')
      setLoading(false)
      return
    }

    const client = await getSupabaseClient()
    const { start, end } = getMonthRange(selectedMonth)

    const [transactionResult, settingsResult] = await Promise.all([
      client
        .from('transactions')
        .select('id,budget_id,type,amount,category,note,tx_date,created_at')
        .eq('budget_id', spaceId)
        .gte('tx_date', start)
        .lt('tx_date', end)
        .order('tx_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(150),
      client
        .from('budget_settings')
        .select('monthly_budget')
        .eq('budget_id', spaceId)
        .maybeSingle()
    ])

    if (transactionResult.error) {
      setError(transactionResult.error.message)
      setSyncText('Could not sync')
      setLoading(false)
      return
    }

    const nextTransactions = transactionResult.data || []
    let nextBudget = defaultBudget

    if (settingsResult.error) {
      setError(settingsResult.error.message)
    } else if (settingsResult.data?.monthly_budget !== undefined && settingsResult.data?.monthly_budget !== null) {
      nextBudget = Number(settingsResult.data.monthly_budget)
    } else {
      await client.from('budget_settings').upsert({ budget_id: spaceId, monthly_budget: defaultBudget })
    }

    setTransactions(nextTransactions)
    setMonthlyBudget(nextBudget)
    setSyncText(`Synced ${new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' })}`)
    writeJson(cacheKey, { transactions: nextTransactions, savedAt: Date.now() })
    writeJson(settingsKey, { monthlyBudget: nextBudget, savedAt: Date.now() })
    setLoading(false)
  }, [cacheKey, selectedMonth, settingsKey, spaceId])

  useEffect(() => {
    const cached = readJson(cacheKey)
    const cachedSettings = readJson(settingsKey)

    if (cached || cachedSettings) {
      setTransactions(cached?.transactions || [])
      if (cachedSettings?.monthlyBudget) setMonthlyBudget(Number(cachedSettings.monthlyBudget))
      setLoading(false)
      setSyncText(isSupabaseConfigured ? 'Showing saved data' : 'Local only')
      loadData({ silent: true })
    } else {
      setTransactions([])
      setLoading(true)
      setSyncText(isSupabaseConfigured ? 'Syncing...' : 'Local mode')
      loadData()
    }
  }, [cacheKey, loadData, settingsKey])

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined

    let channel
    let cancelled = false

    getSupabaseClient().then((client) => {
      if (!client || cancelled) return
      channel = client
        .channel(`budget-space-${spaceId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions', filter: `budget_id=eq.${spaceId}` }, () => {
        loadData({ silent: true })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'budget_settings', filter: `budget_id=eq.${spaceId}` }, () => {
        loadData({ silent: true })
      })
        .subscribe()
    })

    return () => {
      cancelled = true
      getSupabaseClient().then((client) => {
        if (client && channel) client.removeChannel(channel)
      })
    }
  }, [loadData, spaceId])

  const stats = useMemo(() => {
    const income = transactions.filter((item) => item.type === 'income').reduce((sum, item) => sum + cleanNumber(item.amount), 0)
    const expenses = transactions.filter((item) => item.type === 'expense').reduce((sum, item) => sum + cleanNumber(item.amount), 0)
    const balance = income - expenses
    const budgetUsed = monthlyBudget > 0 ? Math.min(100, Math.round((expenses / monthlyBudget) * 100)) : 0
    const remainingBudget = Math.max(0, monthlyBudget - expenses)
    return { income, expenses, balance, budgetUsed, remainingBudget }
  }, [transactions, monthlyBudget])

  const categoryBreakdown = useMemo(() => {
    const totals = {}
    transactions.filter((item) => item.type === 'expense').forEach((item) => {
      totals[item.category] = (totals[item.category] || 0) + cleanNumber(item.amount)
    })

    return Object.entries(totals)
      .map(([category, amount]) => ({ category, amount, percent: stats.expenses ? Math.round((amount / stats.expenses) * 100) : 0 }))
      .sort((a, b) => b.amount - a.amount)
  }, [transactions, stats.expenses])

  const visibleTransactions = useMemo(() => {
    if (filter === 'all') return transactions
    return transactions.filter((item) => item.type === filter)
  }, [transactions, filter])

  async function addTransaction(payload) {
    const optimisticId = `temp-${globalThis.crypto?.randomUUID?.() || Date.now()}`
    const optimisticItem = {
      id: optimisticId,
      budget_id: spaceId,
      ...payload,
      amount: Number(payload.amount),
      created_at: new Date().toISOString()
    }

    setTransactions((items) => [optimisticItem, ...items])
    setShowAdd(false)

    if (!isSupabaseConfigured) {
      const next = [optimisticItem, ...transactions]
      writeJson(cacheKey, { transactions: next, savedAt: Date.now() })
      setSyncText('Saved locally')
      return true
    }

    const client = await getSupabaseClient()
    const { error: insertError } = await client.from('transactions').insert({
      budget_id: spaceId,
      type: payload.type,
      amount: Number(payload.amount),
      category: payload.category,
      note: payload.note,
      tx_date: payload.tx_date
    })

    if (insertError) {
      setTransactions((items) => items.filter((item) => item.id !== optimisticId))
      setError(insertError.message)
      return false
    }

    loadData({ silent: true })
    return true
  }

  async function deleteTransaction(id) {
    const beforeDelete = transactions
    const next = transactions.filter((item) => item.id !== id)
    setTransactions(next)

    if (!isSupabaseConfigured || String(id).startsWith('temp-')) {
      writeJson(cacheKey, { transactions: next, savedAt: Date.now() })
      setSyncText('Saved locally')
      return
    }

    const client = await getSupabaseClient()
    const { error: deleteError } = await client
      .from('transactions')
      .delete()
      .eq('id', id)
      .eq('budget_id', spaceId)

    if (deleteError) {
      setTransactions(beforeDelete)
      setError(deleteError.message)
      return
    }

    loadData({ silent: true })
  }

  async function saveBudget(value) {
    const amount = Math.max(0, Number(value) || 0)
    setMonthlyBudget(amount)
    writeJson(settingsKey, { monthlyBudget: amount, savedAt: Date.now() })

    if (!isSupabaseConfigured) {
      setSyncText('Saved locally')
      return
    }

    setSyncText('Saving...')
    const client = await getSupabaseClient()
    const { error: settingsError } = await client
      .from('budget_settings')
      .upsert({ budget_id: spaceId, monthly_budget: amount })

    if (settingsError) {
      setError(settingsError.message)
      setSyncText('Could not save budget')
      return
    }

    setSyncText('Budget saved')
    loadData({ silent: true })
  }

  function switchSpace(nextValue) {
    const next = normalizeSpaceId(nextValue)
    if (!next) return
    localStorage.setItem(spaceStorageKey, next)
    setSpaceId(next)
    setTransactions([])
    setActiveTab('overview')
  }

  function makeNewSpace() {
    const next = makeSpaceId()
    localStorage.setItem(spaceStorageKey, next)
    setSpaceId(next)
    setTransactions([])
    setActiveTab('overview')
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">PKR Budget</p>
          <h1>{activeTab === 'overview' ? 'Overview' : activeTab === 'history' ? 'History' : activeTab === 'categories' ? 'Categories' : 'Settings'}</h1>
          <span className="sync-dot">{syncText}</span>
        </div>
        <MonthPicker value={selectedMonth} onChange={setSelectedMonth} />
      </header>

      {!isSupabaseConfigured && (
        <div className="notice-banner">Supabase is not configured yet. The app is running locally until you add your URL and publishable key.</div>
      )}
      {error && <div className="error-banner">{error}</div>}

      <section className="tab-content">
        {activeTab === 'overview' && (
          <OverviewTab stats={stats} budget={monthlyBudget} onSaveBudget={saveBudget} loading={loading} transactions={transactions.slice(0, 4)} />
        )}

        {activeTab === 'history' && (
          <HistoryTab loading={loading} items={visibleTransactions} filter={filter} onFilter={setFilter} onDelete={deleteTransaction} />
        )}

        {activeTab === 'categories' && (
          <CategoriesTab categories={categoryBreakdown} total={stats.expenses} />
        )}

        {activeTab === 'settings' && (
          <SettingsTab spaceId={spaceId} onSwitchSpace={switchSpace} onNewSpace={makeNewSpace} budget={monthlyBudget} onSaveBudget={saveBudget} />
        )}
      </section>

      <button className="fab" onClick={() => setShowAdd(true)} aria-label="Add transaction">+</button>
      <BottomNav activeTab={activeTab} onTab={setActiveTab} />

      {showAdd && <AddModal onClose={() => setShowAdd(false)} onAdd={addTransaction} />}
    </main>
  )
}

function MonthPicker({ value, onChange }) {
  return (
    <label className="month-picker">
      Month
      <input type="month" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}

function OverviewTab({ stats, budget, onSaveBudget, transactions }) {
  return (
    <div className="screen-grid">
      <section className="summary-grid">
        <SummaryCard title="Income" value={formatPKR(stats.income)} tone="income" />
        <SummaryCard title="Expenses" value={formatPKR(stats.expenses)} tone="expense" />
        <SummaryCard title="Balance" value={formatPKR(stats.balance)} tone={stats.balance >= 0 ? 'income' : 'expense'} />
      </section>

      <BudgetMeter used={stats.budgetUsed} spent={stats.expenses} remaining={stats.remainingBudget} budget={budget} />
      <BudgetInput value={budget} onSave={onSaveBudget} />
      <MiniHistory items={transactions} />
    </div>
  )
}

function HistoryTab({ items, loading, filter, onFilter, onDelete }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Previous transactions</p>
          <h2>{items.length} records</h2>
        </div>
      </div>
      <FilterTabs filter={filter} onFilter={onFilter} />
      <TransactionList loading={loading} items={items} onDelete={onDelete} />
    </section>
  )
}

function CategoriesTab({ categories, total }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Expense split</p>
          <h2>Categories</h2>
        </div>
        <span className="mini-total">{formatPKR(total)}</span>
      </div>

      {categories.length === 0 ? (
        <p className="empty-text">No expenses this month.</p>
      ) : (
        <div className="category-list">
          {categories.map((item) => (
            <div className="category-row" key={item.category}>
              <div className="category-meta">
                <span>{item.category}</span>
                <b>{formatPKR(item.amount)}</b>
              </div>
              <div className="thin-track"><div style={{ width: `${item.percent}%` }} /></div>
              <small>{item.percent}% of expenses</small>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function SettingsTab({ spaceId, onSwitchSpace, onNewSpace, budget, onSaveBudget }) {
  const [draftSpace, setDraftSpace] = useState(spaceId)

  useEffect(() => {
    setDraftSpace(spaceId)
  }, [spaceId])

  async function copySpace() {
    try {
      await navigator.clipboard.writeText(spaceId)
    } catch {
      // Clipboard permission can be blocked. The visible code can still be copied manually.
    }
  }

  return (
    <div className="screen-grid settings-grid">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Device sync</p>
            <h2>Budget Space</h2>
          </div>
        </div>
        <p className="help-text">Use the same Budget Space code on your phone, iPad, and Windows device to sync the same data without accounts.</p>
        <div className="space-code">{spaceId}</div>
        <div className="button-row">
          <button className="ghost-btn" onClick={copySpace}>Copy code</button>
          <button className="ghost-btn" onClick={onNewSpace}>New space</button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Switch device</p>
            <h2>Enter code</h2>
          </div>
        </div>
        <label>
          Budget Space code
          <input value={draftSpace} onChange={(event) => setDraftSpace(event.target.value)} placeholder="PKR-ABC12345" />
        </label>
        <button className="primary-btn" onClick={() => onSwitchSpace(draftSpace)}>Use this code</button>
      </section>

      <BudgetInput value={budget} onSave={onSaveBudget} />
    </div>
  )
}

function BudgetInput({ value, onSave }) {
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [value])

  function commit() {
    if (Number(draft) !== Number(value)) onSave(draft)
  }

  return (
    <section className="panel budget-input-card">
      <label>
        Monthly expense limit
        <input
          type="number"
          inputMode="numeric"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          min="0"
        />
      </label>
    </section>
  )
}

function SummaryCard({ title, value, tone }) {
  return (
    <article className={`summary-card ${tone}`}>
      <span>{title}</span>
      <strong>{value}</strong>
    </article>
  )
}

function BudgetMeter({ used, spent, remaining, budget }) {
  return (
    <section className="panel budget-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Monthly limit</p>
          <h2>{used}% used</h2>
        </div>
        <span className={used >= 90 ? 'pill danger' : used >= 70 ? 'pill warning' : 'pill safe'}>
          {used >= 90 ? 'High' : used >= 70 ? 'Careful' : 'On track'}
        </span>
      </div>
      <div className="meter-track"><div className="meter-fill" style={{ width: `${used}%` }} /></div>
      <div className="budget-numbers">
        <span>Spent <b>{formatPKR(spent)}</b></span>
        <span>Limit <b>{formatPKR(budget)}</b></span>
        <span>Left <b>{formatPKR(remaining)}</b></span>
      </div>
    </section>
  )
}

function MiniHistory({ items }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Recent</p>
          <h2>Last transactions</h2>
        </div>
      </div>
      {items.length === 0 ? <p className="empty-text">Tap + to add your first transaction.</p> : <TransactionList items={items} loading={false} compact />}
    </section>
  )
}

function FilterTabs({ filter, onFilter }) {
  return (
    <div className="mini-tabs" aria-label="Transaction filter">
      <button className={filter === 'all' ? 'active' : ''} onClick={() => onFilter('all')}>All</button>
      <button className={filter === 'expense' ? 'active' : ''} onClick={() => onFilter('expense')}>Expenses</button>
      <button className={filter === 'income' ? 'active' : ''} onClick={() => onFilter('income')}>Income</button>
    </div>
  )
}

function TransactionList({ items, loading, onDelete, compact = false }) {
  if (loading) return <p className="empty-text">Syncing transactions...</p>
  if (!loading && items.length === 0) return <p className="empty-text">No matching transactions.</p>

  return (
    <div className={`transaction-list ${compact ? 'compact-list' : ''}`}>
      {items.map((item) => (
        <article className="transaction-item" key={item.id}>
          <div className={`type-dot ${item.type}`} />
          <div className="transaction-main">
            <strong>{item.category}</strong>
            <span>{item.note || 'No note'} • {new Date(item.tx_date).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          </div>
          <div className="transaction-side">
            <b className={item.type === 'income' ? 'money-in' : 'money-out'}>
              {item.type === 'income' ? '+' : '-'}{formatPKR(item.amount)}
            </b>
            {onDelete && !String(item.id).startsWith('temp-') && <button onClick={() => onDelete(item.id)} aria-label="Delete transaction">Delete</button>}
          </div>
        </article>
      ))}
    </div>
  )
}

function AddModal({ onClose, onAdd }) {
  const [type, setType] = useState('expense')
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState('Food')
  const [note, setNote] = useState('')
  const [txDate, setTxDate] = useState(today)
  const [busy, setBusy] = useState(false)
  const expenseCategoryEmojis = [
    { name: 'Food', emoji: '🍕' },
    { name: 'Transport', emoji: '🚗' },
    { name: 'Bills', emoji: '🧾' },
    { name: 'Shopping', emoji: '🛍️' },
    { name: 'Health', emoji: '💊' },
    { name: 'Savings', emoji: '💰' }
  ]
  const incomeCategoryEmojis = [
    { name: 'Salary', emoji: '💼' },
    { name: 'Freelance', emoji: '💻' },
    { name: 'Business', emoji: '📈' },
    { name: 'Gift', emoji: '🎁' },
    { name: 'Investment', emoji: '📊' },
    { name: 'Other Income', emoji: '💵' }
  ]
  const categories = type === 'income' ? incomeCategoryEmojis : expenseCategoryEmojis

  function handleTypeChange(nextType) {
    setType(nextType)
    setCategory(nextType === 'income' ? incomeCategoryEmojis[0].name : expenseCategoryEmojis[0].name)
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (!amount || Number(amount) <= 0) return
    setBusy(true)
    const ok = await onAdd({ type, amount, category, note: note.trim(), tx_date: txDate })
    setBusy(false)
    if (ok) {
      setAmount('')
      setNote('')
      setTxDate(today)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal-card">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Quick add</p>
            <h2>New transaction</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>

        <form onSubmit={handleSubmit} className="transaction-form">
          <div className="segmented">
            <button type="button" className={type === 'expense' ? 'active' : ''} onClick={() => handleTypeChange('expense')}>Expense</button>
            <button type="button" className={type === 'income' ? 'active' : ''} onClick={() => handleTypeChange('income')}>Income</button>
          </div>

          <label>
            Amount in PKR
            <input type="number" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="e.g. 1500" min="1" autoFocus required />
          </label>

          <div className="emoji-categories">
            {categories.map((item) => (
              <button
                key={item.name}
                type="button"
                className={`emoji-btn ${category === item.name ? 'active' : ''}`}
                onClick={() => setCategory(item.name)}
                aria-label={item.name}
              >
                <span className="emoji-icon">{item.emoji}</span>
                <span className="emoji-label">{item.name}</span>
              </button>
            ))}
          </div>

          <div className="two-fields">
            <label>
              Date
              <input type="date" value={txDate} onChange={(event) => setTxDate(event.target.value)} required />
            </label>
          </div>

          <label>
            Note
            <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional" maxLength="80" />
          </label>

          <button className="primary-btn" disabled={busy}>{busy ? 'Adding...' : 'Add transaction'}</button>
        </form>
      </section>
    </div>
  )
}

function BottomNav({ activeTab, onTab }) {
  const tabs = [
    { id: 'overview', icon: '⌂', label: 'Overview' },
    { id: 'history', icon: '↕', label: 'History' },
    { id: 'categories', icon: '◔', label: 'Categories' },
    { id: 'settings', icon: '⚙', label: 'Settings' }
  ]

  return (
    <nav className="bottom-nav" aria-label="Main navigation">
      {tabs.map((tab) => (
        <button key={tab.id} className={activeTab === tab.id ? 'active' : ''} onClick={() => onTab(tab.id)}>
          <span>{tab.icon}</span>
          {tab.label}
        </button>
      ))}
    </nav>
  )
}
