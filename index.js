require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const allowedUserId = parseInt(process.env.ALLOWED_USER_ID, 10);

// --- 1. INSTRUKSI MASTER (ROUTER & PENCATAT) ---
const masterInstruction = `
Kamu adalah asisten keuangan pribadi yang jenius. Baca pesan atau gambar dari user, lalu tentukan apa maksud (intent) user. 
Balas HANYA dengan satu objek JSON yang valid tanpa markdown teks tambahan.

Pilihan "intent":
1. "record": User memberikan data uang masuk/keluar.
2. "saldo": User menanyakan sisa uang/saldo total keseluruhan.
3. "report": User menanyakan total/laporan bulan ini.
4. "analisa": User meminta saran, evaluasi, atau curhat soal keuangannya.
5. "other": User hanya menyapa (Halo, Pagi) atau ngobrol di luar konteks.

Format JSON Wajib:
{
  "intent": "record" | "saldo" | "report" | "analisa" | "other",
  "record_data": {
    "type": "income" | "expense",
    "amount": angka_tanpa_titik,
    "category": "string",
    "description": "string",
    "status": "success" | "error"
  },
  "reply": "Isi dengan balasan ramah JIKA intent adalah 'other' (misal membalas sapaan)"
}
`;

// --- 2. INSTRUKSI KHUSUS ANALISA ---
const analysisInstruction = `
Kamu adalah penasihat keuangan profesional. Analisis data transaksi berformat JSON berikut.
Berikan ringkasan, evaluasi arus kas, deteksi pemborosan, dan saran praktis. Gunakan bahasa Indonesia santai dan emoji.
`;

console.log('✅ Bot Asisten Keuangan Fleksibel (NLP) menyala...');

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userText = msg.text || '';
  
  if (userId !== allowedUserId) return;

  bot.sendChatAction(chatId, 'typing');

  try {
    // ==========================================
    // FASE 1: GEMINI MEMAHAMI MAKSUD USER (ROUTING)
    // ==========================================
    const masterModel = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      systemInstruction: masterInstruction,
      generationConfig: { responseMimeType: "application/json" }
    });

    let jsonResponseText = '';

    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      const fileLink = await bot.getFileLink(photoId);
      const response = await fetch(fileLink);
      const arrayBuffer = await response.arrayBuffer();
      const base64Data = Buffer.from(arrayBuffer).toString('base64');
      const imagePart = { inlineData: { data: base64Data, mimeType: 'image/jpeg' } };
      
      const result = await masterModel.generateContent(["Apa maksud dari gambar ini? Jika ini struk, ekstrak datanya.", imagePart]);
      jsonResponseText = result.response.text();
    } else if (userText) {
      const result = await masterModel.generateContent(userText);
      jsonResponseText = result.response.text();
    } else {
      return; // Abaikan stiker/dokumen
    }

    const botDecision = JSON.parse(jsonResponseText);
    const intent = botDecision.intent;

    // ==========================================
    // FASE 2: EKSEKUSI SESUAI MAKSUD (INTENT)
    // ==========================================

    if (intent === 'other') {
      // Jika user cuma bilang "Halo" atau curhat biasa
      bot.sendMessage(chatId, botDecision.reply);
      return;
    }

    if (intent === 'record') {
      const data = botDecision.record_data;
      if (data && data.status === 'success') {
        await supabase.from('transactions').insert([{
          user_id: userId, type: data.type, amount: data.amount,
          category: data.category, description: data.description
        }]);
        const jenis = data.type === 'income' ? 'Pemasukan' : 'Pengeluaran';
        bot.sendMessage(chatId, `✅ *${jenis} Dicatat!*\n📂 ${data.category}\n💵 Rp${data.amount.toLocaleString('id-ID')}\n📝 ${data.description}`, { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(chatId, "🤔 Maaf, aku ga nemu nominal atau data yang jelas untuk dicatat.");
      }
      return;
    }

    if (intent === 'saldo') {
      const { data, error } = await supabase.from('transactions').select('type, amount').eq('user_id', userId);
      if (error) throw error;
      let income = 0, expense = 0;
      data.forEach(t => { t.type === 'income' ? income += Number(t.amount) : expense += Number(t.amount); });
      const balance = income - expense;
      bot.sendMessage(chatId, `💰 *Sisa Uangmu Sekarang: Rp${balance.toLocaleString('id-ID')}*\n(Total Pemasukan: Rp${income.toLocaleString('id-ID')} | Pengeluaran: Rp${expense.toLocaleString('id-ID')})`, { parse_mode: 'Markdown' });
      return;
    }

    if (intent === 'report') {
      const now = new Date();
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const { data, error } = await supabase.from('transactions').select('type, amount').eq('user_id', userId).gte('created_at', firstDay);
      if (error) throw error;
      let incMonth = 0, expMonth = 0;
      data.forEach(t => { t.type === 'income' ? incMonth += Number(t.amount) : expMonth += Number(t.amount); });
      bot.sendMessage(chatId, `📊 *Laporan Bulan Ini*\n🟢 Pemasukan: Rp${incMonth.toLocaleString('id-ID')}\n🔴 Pengeluaran: Rp${expMonth.toLocaleString('id-ID')}`, { parse_mode: 'Markdown' });
      return;
    }

    if (intent === 'analisa') {
      bot.sendMessage(chatId, "⏳ Sebentar, aku baca catatan transaksimu bulan ini dulu ya...");
      const now = new Date();
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const { data, error } = await supabase.from('transactions').select('type, amount, category, description').eq('user_id', userId).gte('created_at', firstDay);
      if (error) throw error;
      
      if (data.length === 0) {
        bot.sendMessage(chatId, "Kamu belum mencatat apa-apa bulan ini, jadi belum bisa dianalisa nih!");
        return;
      }

      const analysisModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash", systemInstruction: analysisInstruction });
      const prompt = `Ini dataku bulan ini: ${JSON.stringify(data)}. Tolong analisakan.`;
      const result = await analysisModel.generateContent(prompt);
      bot.sendMessage(chatId, result.response.text(), { parse_mode: 'Markdown' });
      return;
    }

  } catch (error) {
    console.error('Error Global:', error);
    bot.sendMessage(chatId, "⚠️ Waduh, ada sedikit gangguan di sistemku nih.");
  }
});