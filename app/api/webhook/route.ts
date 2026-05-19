import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const TOKEN = process.env.BOT_TOKEN!

async function sendMessage(chat_id: number, text: string) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        chat_id, 
        text, 
        parse_mode: 'HTML'
      })
    })

    if (!res.ok) {
      const errData = await res.json()
      console.error("❌ Telegram API Error:", errData)
    }
  } catch (e) {
    console.error("❌ Fetch failed:", e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    
    // Log the event to verify the request hits Vercel
    console.log("👉 Data received from Telegram:", JSON.stringify(body))

    const message = body.message
    if (!message || !message.text) {
      return NextResponse.json({ ok: true })
    }

    const chat_id = message.chat.id
    const text = message.text.trim()

    if (text === '/start') {
      await sendMessage(chat_id, `⚡ <b>Connection Alive!</b>\n\nYour Vercel server is successfully reading your token and talking to Telegram.`)
    } else {
      await sendMessage(chat_id, `You said: <code>${text}</code>`)
    }

    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error("💥 Diagnostic Webhook Crash:", err.message || err)
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 })
  }
}