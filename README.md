# PKR Budget Tracker PWA

A basic, dark, mobile-first budget tracking PWA for Pakistani Rupees. It tracks income, expenses, monthly spending limit, category split, and previous transactions.

## New no-login flow

This version has no sign-in screen and no create-account screen. It opens directly into the app.

To sync the same data across your mobile, iPad, and Windows device, use the same **Budget Space** code in the Settings tab. This is not a password or account; it is a simple shared code used to separate one budget from another.

> Important: no-login mode is convenient, but it is not as private as user authentication. Anyone with the same Supabase project access and Budget Space code can read/write that space. For a private multi-user production app, use login again.

## Setup

1. Create a Supabase project.
2. Go to Supabase SQL Editor.
3. Run `supabase/schema.sql`.
4. Copy your Supabase Project URL and publishable/anon key into `.env`.

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-publishable-or-anon-key
```

## Run locally

```bash
npm install
npm run dev
```

## Build for production

```bash
npm run build
npm run preview
```

## Main features

- No login or account creation
- PKR currency formatting
- Income and expense tracking
- Bottom navigation tabs: Overview, History, Categories, Settings
- Floating plus button for adding income/expense
- Monthly expense limit
- Previous transactions list
- Category breakdown
- Supabase sync when configured
- Local-only fallback when Supabase env values are missing
- Mobile-first dark minimal UI
- Responsive layout for iPad and Windows screens
- PWA install support
