import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const TOKEN = process.env.BOT_TOKEN!
const CURRENCY = "so'm"

// Lazy-load Supabase helper to prevent build errors
function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_KEY
  if (!url || !key) {
    throw new Error('Supabase environment variables are missing.')
  }
  return createClient(url, key)
}

// ── Telegram helpers ──────────────────────────────────────────────────────────
async function sendMessage(chat_id: number, text: string, reply_markup?: object) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      chat_id, 
      text, 
      parse_mode: 'Markdown', 
      // Telegram requires reply_markup to be a JSON string stringified
      reply_markup: reply_markup ? JSON.stringify(reply_markup) : undefined 
    })
  })
}

async function answerCallbackQuery(callback_query_id: string) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id })
  })
}

// ── Keyboards ─────────────────────────────────────────────────────────────────
const mainMenu = {
  keyboard: [
    [{ text: '➕ Add income' },  { text: '➖ Add expense' }],
    [{ text: '📊 Summary' },     { text: '📅 This month' }],
    [{ text: '📆 This week' },   { text: '📋 Last 10' }],
    [{ text: '❓ Help' }],
  ],
  resize_keyboard: true,
  one_time_keyboard: false,
}

const incomeCategories = {
  inline_keyboard: [
    [
      { text: '💼 Salary',     callback_data: 'cat_income_salary' },
      { text: '📈 Investment', callback_data: 'cat_income_investment' },
    ],
    [{ text: '✏️ Other',       callback_data: 'cat_income_other' }],
  ]
}

const expenseCategories = {
  inline_keyboard: [
    [
      { text: '🛒 Food',      callback_data: 'cat_expense_food' },
      { text: '🚌 Transport', callback_data: 'cat_expense_transport' },
    ],
    [
      { text: '🎮 Fun',       callback_data: 'cat_expense_fun' },
      { text: '🛍️ Shopping',  callback_data: 'cat_expense_shopping' },
    ],
    [{ text: '✏️ Other',      callback_data: 'cat_expense_other' }],
  ]
}

// ── In-memory pending state ───────────────────────────────────────────────────
const pendingEntry: Record<number, { type: 'income' | 'expense'; amount: number }> = {}

// ── Business logic ────────────────────────────────────────────────────────────
async function handleSummary(chat_id: number) {
  const supabase = getSupabase()
  const { data } = await supabase
    .from('transactions')
    .select('type, amount')
    .eq('chat_id', chat_id)

  const income  = data?.filter(t => t.type === 'income' ).reduce((s, t) => s + Number(t.amount), 0) ?? 0
  const expense = data?.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0) ?? 0

  await sendMessage(chat_id,
    `📊 *All-time summary*\n\n` +
    `💚 Income:   *${income.toLocaleString()} ${CURRENCY}*\n` +
    `🔴 Expenses: *${expense.toLocaleString()} ${CURRENCY}*\n` +
    `─────────────────\n` +
    `💰 Balance:  *${(income - expense).toLocaleString()} ${CURRENCY}*`,
    mainMenu
  )
}

async function handlePeriod(chat_id: number, label: string, since: Date) {
  const supabase = getSupabase()
  const { data } = await supabase
    .from('transactions')
    .select('type, amount, category')
    .eq('chat_id', chat_id)
    .gte('created_at', since.toISOString())

  const income  = data?.filter(t => t.type === 'income' ).reduce((s, t) => s + Number(t.amount), 0) ?? 0
  const expense = data?.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0) ?? 0

  const byCategory: Record<string, number> = {}
  data?.filter(t => t.type === 'expense').forEach(t => {
    byCategory[t.category] = (byCategory[t.category] ?? 0) + Number(t.amount)
  })

  const catLines = Object.entries(byCategory)
    .sort(([, a], [, b]) => b - a)
    .map(([cat, amt]) => `  • ${cat}: ${amt.toLocaleString()} ${CURRENCY}`)
    .join('\n')

  await sendMessage(chat_id,
    `${label}\n\n` +
    `💚 Income:   *${income.toLocaleString()} ${CURRENCY}*\n` +
    `🔴 Expenses: *${expense.toLocaleString()} ${CURRENCY}*\n` +
    `💰 Balance:  *${(income - expense).toLocaleString()} ${CURRENCY}*\n\n` +
    (catLines ? `*By category:*\n${catLines}` : '_No expenses yet_'),
    mainMenu
  )
}

async function handleList(chat_id: number) {
  const supabase = getSupabase()
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .eq('chat_id', chat_id)
    .order('created_at', { ascending: false })
    .limit(10)

  if (!data?.length) {
    await sendMessage(chat_id, '_No transactions yet._', mainMenu)
    return
  }

  const lines = data.map(t => {
    const icon = t.type === 'income' ? '💚' : '🔴'
    const date = new Date(t.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
    return `${icon} ${date}  *${Number(t.amount).toLocaleString()} ${CURRENCY}*  _${t.category}_`
  })

  await sendMessage(chat_id, `📋 *Last 10 transactions*\n\n${lines.join('\n')}`, mainMenu)
}

// ── Webhook handler ───────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabase()
    const body = await req.json()

    // ── Inline button tapped ──────────────────────────────────────────────────
    if (body.callback_query) {
      const { id, from, data } = body.callback_query
      const chat_id = from.id
      await answerCallbackQuery(id)

      const [, type, category] = data.split('_') as ['cat', 'income' | 'expense', string]
      const pending = pendingEntry[chat_id]

      if (!pending) {
        await sendMessage(chat_id, '⚠️ Session expired. Please start again.', mainMenu)
        return NextResponse.json({ ok: true })
      }

      delete pendingEntry[chat_id]
      await supabase.from('transactions').insert({
        chat_id,
        type: pending.type,
        amount: pending.amount,
        category,
      })

      const sign = pending.type === 'income' ? '+' : '-'
      await sendMessage(chat_id,
        `✅ *${pending.type === 'income' ? 'Income' : 'Expense'} saved*\n` +
        `${sign}${pending.amount.toLocaleString()} ${CURRENCY}  ·  ${category}`,
        mainMenu
      )
      return NextResponse.json({ ok: true })
    }

    // ── Regular message ───────────────────────────────────────────────────────
    const message = body.message
    if (!message?.text) return NextResponse.json({ ok: true })

    const chat_id: number = message.chat.id
    const text: string    = message.text.trim()

    await supabase.from('users').upsert({ chat_id }, { onConflict: 'chat_id' })

    const textMap: Record<string, string> = {
      '➕ add income':  '/add_income',
      '➖ add expense': '/add_expense',
      '📊 summary':     '/summary',
      '📅 this month':  '/month',
      '📆 this week':   '/week',
      '📋 last 10':     '/list',
      '❓ help':        '/help',
    }

    const cmd = textMap[text.toLowerCase()] ?? text

    if (cmd === '/start') {
      await sendMessage(chat_id,
        `👋 *Salom! Finance Bot*\n\nTrack your income & expenses in *so'm*.\nUse the buttons below to get started.`,
        mainMenu
      )
    } else if (cmd.startsWith('/add_income')) {
      const amount = parseFloat(cmd.split(' ')[1])
      if (isNaN(amount)) {
        await sendMessage(chat_id, `💚 *Add income*\n\nSend the amount:\n\`/add_income 500000\``)
      } else {
        pendingEntry[chat_id] = { type: 'income', amount }
        await sendMessage(chat_id, `💚 *${amount.toLocaleString()} ${CURRENCY}* — choose a category:`, incomeCategories)
      }
    } else if (cmd.startsWith('/add_expense')) {
      const amount = parseFloat(cmd.split(' ')[1])
      if (isNaN(amount)) {
        await sendMessage(chat_id, `🔴 *Add expense*\n\nSend the amount:\n\`/add_expense 50000\``)
      } else {
        pendingEntry[chat_id] = { type: 'expense', amount }
        await sendMessage(chat_id, `🔴 *${amount.toLocaleString()} ${CURRENCY}* — choose a category:`, expenseCategories)
      }
    } else if (cmd === '/summary') {
      await handleSummary(chat_id)
    } else if (cmd === '/month') {
      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      const monthName = now.toLocaleString('en', { month: 'long' })
      await handlePeriod(chat_id, `📅 *${monthName} summary*`, start)
    } else if (cmd === '/week') {
      const now = new Date()
      const day = now.getDay()
      const diffToMonday = (day === 0 ? -6 : 1 - day)
      const start = new Date(now)
      start.setDate(now.getDate() + diffToMonday)
      start.setHours(0, 0, 0, 0)
      await handlePeriod(chat_id, `📆 *This week's summary*`, start)
    } else if (cmd === '/list') {
      await handleList(chat_id)
    } else if (cmd === '/help') {
      await sendMessage(chat_id,
        `*Commands*\n\n` +
        `/add_income 500000  — add income\n` +
        `/add_expense 50000  — add expense\n` +
        `/summary            — all-time totals\n` +
        `/month              — this month\n` +
        `/week               — this week\n` +
        `/list               — last 10 transactions\n\n` +
        `_Default currency: so'm (UZS)_`,
        mainMenu
      )
    } else {
      await sendMessage(chat_id,
        `Use the buttons below or:\n/add_income 500000\n/add_expense 50000`,
        mainMenu
      )
    }
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error("💥 WEBHOOK ERROR:", err.message || err)
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 })
  }
}