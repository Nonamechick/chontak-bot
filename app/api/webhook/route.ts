import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const TOKEN = process.env.BOT_TOKEN!
const CURRENCY = "so'm"

// Lazy-load Supabase helper to prevent build or environment configuration locks
function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_KEY
  if (!url || !key) {
    throw new Error('Supabase environment variables are missing.')
  }
  return createClient(url, key)
}

// ── Telegram API Helpers ──────────────────────────────────────────────────────
async function sendMessage(chat_id: number, text: string, reply_markup?: object) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      chat_id, 
      text, 
      parse_mode: 'HTML', 
      reply_markup: reply_markup ? JSON.stringify(reply_markup) : undefined 
    })
  })

  if (!res.ok) {
    const errData = await res.json()
    console.error("❌ Telegram API Error:", errData)
  }
}

async function answerCallbackQuery(callback_query_id: string) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id })
  })
}

// ── Persistent & Inline Keyboards ────────────────────────────────────────────
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

// ── In-Memory States ──────────────────────────────────────────────────────────
const userState: Record<number, 'AWAITING_INCOME_AMOUNT' | 'AWAITING_EXPENSE_AMOUNT'> = {}
const pendingEntry: Record<number, { type: 'income' | 'expense'; amount: number }> = {}

// ── Database Queries & Business Logic ────────────────────────────────────────
async function handleSummary(chat_id: number) {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('transactions')
    .select('type, amount')
    .eq('chat_id', chat_id)

  if (error) {
    console.error("❌ Supabase Fetch Summary Error:", error)
    await sendMessage(chat_id, `❌ Database error: <code>${error.message}</code>`, mainMenu)
    return
  }

  const income  = data?.filter(t => t.type === 'income' ).reduce((s, t) => s + Number(t.amount), 0) ?? 0
  const expense = data?.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0) ?? 0

  await sendMessage(chat_id,
    `📊 <b>All-time summary</b>\n\n` +
    `💚 Income:   <b>${income.toLocaleString()} ${CURRENCY}</b>\n` +
    `🔴 Expenses: <b>${expense.toLocaleString()} ${CURRENCY}</b>\n` +
    `─────────────────\n` +
    `💰 Balance:  <b>${(income - expense).toLocaleString()} ${CURRENCY}</b>`,
    mainMenu
  )
}

async function handlePeriod(chat_id: number, label: string, since: Date) {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('transactions')
    .select('type, amount, category')
    .eq('chat_id', chat_id)
    .gte('created_at', since.toISOString())

  if (error) {
    console.error("❌ Supabase Fetch Period Error:", error)
    await sendMessage(chat_id, `❌ Database error: <code>${error.message}</code>`, mainMenu)
    return
  }

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
    `💚 Income:   <b>${income.toLocaleString()} ${CURRENCY}</b>\n` +
    `🔴 Expenses: <b>${expense.toLocaleString()} ${CURRENCY}</b>\n` +
    `💰 Balance:  <b>${(income - expense).toLocaleString()} ${CURRENCY}</b>\n\n` +
    (catLines ? `<b>By category:</b>\n${catLines}` : '<i>No expenses yet</i>'),
    mainMenu
  )
}

async function handleList(chat_id: number) {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('chat_id', chat_id)
    .order('created_at', { ascending: false })
    .limit(10)

  if (error) {
    console.error("❌ Supabase Fetch List Error:", error)
    await sendMessage(chat_id, `❌ Database error: <code>${error.message}</code>`, mainMenu)
    return
  }

  if (!data?.length) {
    await sendMessage(chat_id, '<i>No transactions found yet.</i>', mainMenu)
    return
  }

  const lines = data.map(t => {
    const icon = t.type === 'income' ? '💚' : '🔴'
    const date = new Date(t.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
    return `${icon} ${date}  <b>${Number(t.amount).toLocaleString()} ${CURRENCY}</b>  ·  <i>${t.category}</i>`
  })

  await sendMessage(chat_id, `📋 <b>Last 10 transactions</b>\n\n${lines.join('\n')}`, mainMenu)
}

// ── Core Webhook API Router ──────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabase()
    const body = await req.json()

    // ── Context 1: Inline button category confirmation selection ──────────────
    if (body.callback_query) {
      const { id, from, data } = body.callback_query
      const chat_id = Number(from.id)
      await answerCallbackQuery(id)

      const [, type, category] = data.split('_') as ['cat', 'income' | 'expense', string]
      const pending = pendingEntry[chat_id]

      if (!pending) {
        await sendMessage(chat_id, '⚠️ Session expired. Please start over.', mainMenu)
        return NextResponse.json({ ok: true })
      }

      // Explicit numeric type-casts to ensure database matching layouts map safely
      const { error: dbError } = await supabase.from('transactions').insert({
        chat_id,
        type: pending.type,
        amount: Number(pending.amount),
        category,
      })

      if (dbError) {
        console.error("❌ Supabase Transaction Insert Failed:", dbError)
        await sendMessage(chat_id, `❌ Database write failed: <code>${dbError.message}</code>`, mainMenu)
        return NextResponse.json({ ok: true })
      }

      delete pendingEntry[chat_id]

      const sign = pending.type === 'income' ? '+' : '-'
      await sendMessage(chat_id,
        `✅ <b>${pending.type === 'income' ? 'Income' : 'Expense'} saved</b>\n` +
        `${sign}${pending.amount.toLocaleString()} ${CURRENCY}  ·  ${category}`,
        mainMenu
      )
      return NextResponse.json({ ok: true })
    }

    // ── Context 2: Regular user chat text payload handling ───────────────────
    const message = body.message
    if (!message?.text) return NextResponse.json({ ok: true })

    const chat_id: number = Number(message.chat.id)
    const text: string    = message.text.trim()

    // Synchronize core account row profile logs 
    const { error: userError } = await supabase.from('users').upsert({ chat_id }, { onConflict: 'chat_id' })
    if (userError) console.error("❌ Supabase Profile Handshake Error:", userError)

    // Capture explicit active workflow states
    const currentState = userState[chat_id]
    
    // Regular expression cleans inner numbering spacing tokens safely (e.g. "15 000" -> "15000")
    const cleanText = text.replace(/\s(?=\d)/g, '')
    const parsedAmount = parseFloat(cleanText)

    if (currentState && !isNaN(parsedAmount)) {
      delete userState[chat_id]

      if (currentState === 'AWAITING_INCOME_AMOUNT') {
        pendingEntry[chat_id] = { type: 'income', amount: parsedAmount }
        await sendMessage(chat_id, `💚 <b>${parsedAmount.toLocaleString()} ${CURRENCY}</b> — choose a category:`, incomeCategories)
        return NextResponse.json({ ok: true })
      } 
      
      if (currentState === 'AWAITING_EXPENSE_AMOUNT') {
        pendingEntry[chat_id] = { type: 'expense', amount: parsedAmount }
        await sendMessage(chat_id, `🔴 <b>${parsedAmount.toLocaleString()} ${CURRENCY}</b> — choose a category:`, expenseCategories)
        return NextResponse.json({ ok: true })
      }
    }

    // Command conversion maps for native application menu routing
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
        `👋 <b>Salom! Finance Bot</b>\n\nTrack your income & expenses in <b>so'm</b>.\nUse the buttons below to get started.`,
        mainMenu
      )
    } else if (cmd.startsWith('/add_income')) {
      const parts = cleanText.split(' ')
      const amount = parseFloat(parts[1])

      if (isNaN(amount)) {
        userState[chat_id] = 'AWAITING_INCOME_AMOUNT'
        await sendMessage(chat_id, `💚 <b>Add income</b>\n\nSend the amount now (e.g., 50 000):`)
      } else {
        pendingEntry[chat_id] = { type: 'income', amount }
        await sendMessage(chat_id, `💚 <b>${amount.toLocaleString()} ${CURRENCY}</b> — choose a category:`, incomeCategories)
      }
    } else if (cmd.startsWith('/add_expense')) {
      const parts = cleanText.split(' ')
      const amount = parseFloat(parts[1])

      if (isNaN(amount)) {
        userState[chat_id] = 'AWAITING_EXPENSE_AMOUNT'
        await sendMessage(chat_id, `🔴 <b>Add expense</b>\n\nSend the amount now (e.g., 15 000):`)
      } else {
        pendingEntry[chat_id] = { type: 'expense', amount }
        await sendMessage(chat_id, `🔴 <b>${amount.toLocaleString()} ${CURRENCY}</b> — choose a category:`, expenseCategories)
      }
    } else if (cmd === '/summary') {
      await handleSummary(chat_id)
    } else if (cmd === '/month') {
      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      const monthName = now.toLocaleString('en', { month: 'long' })
      await handlePeriod(chat_id, `📅 <b>${monthName} summary</b>`, start)
    } else if (cmd === '/week') {
      const now = new Date()
      const day = now.getDay()
      const diffToMonday = (day === 0 ? -6 : 1 - day)
      const start = new Date(now)
      start.setDate(now.getDate() + diffToMonday)
      start.setHours(0, 0, 0, 0)
      await handlePeriod(chat_id, `📆 <b>This week's summary</b>`, start)
    } else if (cmd === '/list') {
      await handleList(chat_id)
    } else if (cmd === '/help') {
      await sendMessage(chat_id,
        `<b>Commands</b>\n\n` +
        `/add_income 500000  — add income\n` +
        `/add_expense 50000  — add expense\n` +
        `/summary            — all-time totals\n` +
        `/month              — this month\n` +
        `/week               — this week\n` +
        `/list               — last 10 transactions\n\n` +
        `<i>Default currency: so'm (UZS)</i>`,
        mainMenu
      )
    } else {
      await sendMessage(chat_id,
        `Use the menu buttons below or type an amount directly.`,
        mainMenu
      )
    }
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error("💥 WEBHOOK CRASH:", err.message || err)
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 })
  }
}