require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

// --- INISIALISASI ---
const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const allowedUserId = parseInt(process.env.ALLOWED_USER_ID, 10);

// --- SYSTEM INSTRUCTIONS ---
const recordInstruction = `
Kamu adalah asisten pencatat keuangan pribadi. Tugasmu mengekstrak data transaksi dari pesan user (teks atau foto struk).
1. Respon HARUS SELALU SATU objek JSON valid. Jangan ada teks markdown seperti \`\`\`json.
2. Format berhasil: {"type": "expense" atau "income", "amount": angka (tanpa titik/koma), "category": "string", "description": "string", "status": "success"}
3. Format gagal/bukan transaksi: {"status": "error", "message": "Maaf, itu bukan format transaksi yang saya pahami."}
`;

const analysisInstruction = `
Kamu adalah penasihat keuangan profesional. Analisis data transaksi berformat JSON berikut.
Berikan ringkasan: kategori pengeluaran terbesar, evaluasi arus kas, deteksi pemborosan, dan 3 saran praktis untuk bulan depan.
Gunakan bahasa Indonesia yang santai, rapi, dan gunakan emoji.
`;

console.log('✅ Bot Asisten Keuangan menyala dan siap menerima perintah...');

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userText = msg.text || '';
  
// Proteksi Akses
  if (userId !== allowedUserId) {
    bot.sendMessage(chatId, `Akses ditolak! Tapi hei, ID Telegram kamu adalah: ${userId}`);
    console.log(`Akses ditolak untuk ID: ${userId}. Di .env terbaca: ${allowedUserId}`);
    return;
  }

  try {
    // ==========================================
    // 1. PENANGANAN PERINTAH (COMMANDS)
    // ==========================================
    if (userText.startsWith('/')) {
      
      // -- PERINTAH: /saldo --
      if (userText === '/saldo') {
        bot.sendChatAction(chatId, 'typing');
        const { data, error } = await supabase.from('transactions').select('type, amount').eq('user_id', userId);
        if (error) throw error;

        let income = 0, expense = 0;
        data.forEach(t => {
          if (t.type === 'income') income += Number(t.amount);
          if (t.type === 'expense') expense += Number(t.amount);
        });

        const balance = income - expense;
        const pesan = `💰 *INFORMASI SALDO KESELURUHAN*\n\n📈 Pemasukan: Rp${income.toLocaleString('id-ID')}\n📉 Pengeluaran: Rp${expense.toLocaleString('id-ID')}\n\n💳 *Saldo Tersisa: Rp${balance.toLocaleString('id-ID')}*`;
        bot.sendMessage(chatId, pesan, { parse_mode: 'Markdown' });
        return;
      }

      // -- PERINTAH: /report --
      if (userText === '/report') {
        bot.sendChatAction(chatId, 'typing');
        const now = new Date();
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

        const { data, error } = await supabase
          .from('transactions')
          .select('type, amount')
          .eq('user_id', userId)
          .gte('created_at', firstDay);
        
        if (error) throw error;

        let incomeMonth = 0, expenseMonth = 0;
        data.forEach(t => {
          if (t.type === 'income') incomeMonth += Number(t.amount);
          if (t.type === 'expense') expenseMonth += Number(t.amount);
        });

        const namaBulan = now.toLocaleString('id-ID', { month: 'long', year: 'numeric' });
        const pesan = `📊 *LAPORAN BULAN ${namaBulan.toUpperCase()}*\n\n🟢 Pemasukan: Rp${incomeMonth.toLocaleString('id-ID')}\n🔴 Pengeluaran: Rp${expenseMonth.toLocaleString('id-ID')}`;
        bot.sendMessage(chatId, pesan, { parse_mode: 'Markdown' });
        return;
      }

      // -- PERINTAH: /analisa --
      if (userText === '/analisa') {
        bot.sendChatAction(chatId, 'typing');
        bot.sendMessage(chatId, "⏳ Membaca data transaksi bulan ini dan meracik analisa...");

        const now = new Date();
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

        const { data, error } = await supabase
          .from('transactions')
          .select('type, amount, category, description, created_at')
          .eq('user_id', userId)
          .gte('created_at', firstDay);

        if (error) throw error;
        if (data.length === 0) {
          bot.sendMessage(chatId, "Belum ada transaksi bulan ini untuk dianalisis.");
          return;
        }

        const analysisModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash", systemInstruction: analysisInstruction });
        const dataString = JSON.stringify(data);
        const prompt = `Berikut data transaksiku bulan ini: ${dataString}. Tolong berikan analisamu.`;

        const result = await analysisModel.generateContent(prompt);
        bot.sendMessage(chatId, result.response.text(), { parse_mode: 'Markdown' });
        return;
      }

      bot.sendMessage(chatId, "Perintah tidak dikenali. Gunakan: /saldo, /report, atau /analisa.");
      return;
    }

    // ==========================================
    // 2. PENCATATAN TRANSAKSI (TEKS & STRUK GAMBAR)
    // ==========================================
    bot.sendChatAction(chatId, 'typing');
    
    const recordModel = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      systemInstruction: recordInstruction,
      generationConfig: { responseMimeType: "application/json" }
    });

    let jsonResponseText = '';

    if (msg.photo) {
      // Proses Gambar Struk
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      const fileLink = await bot.getFileLink(photoId);
      const response = await fetch(fileLink);
      const arrayBuffer = await response.arrayBuffer();
      const base64Data = Buffer.from(arrayBuffer).toString('base64');
      const imagePart = { inlineData: { data: base64Data, mimeType: 'image/jpeg' } };
      
      const result = await recordModel.generateContent(["Ekstrak data transaksi keuangan dari gambar ini.", imagePart]);
      jsonResponseText = result.response.text();
    } else if (userText) {
      // Proses Teks
      const result = await recordModel.generateContent(userText);
      jsonResponseText = result.response.text();
    }

    // Parsing hasil JSON dari Gemini
    let transactionData;
    try {
      transactionData = JSON.parse(jsonResponseText);
    } catch (e) {
      console.error("Gagal parse JSON:", jsonResponseText);
      throw new Error("Format AI tidak sesuai JSON.");
    }

    // Eksekusi Penyimpanan Database
    if (transactionData && transactionData.status === 'success') {
      const { error: dbError } = await supabase
        .from('transactions')
        .insert([{
          user_id: userId,
          type: transactionData.type,
          amount: transactionData.amount,
          category: transactionData.category,
          description: transactionData.description
        }]);

      if (dbError) throw dbError;

      const jenis = transactionData.type === 'income' ? 'Pemasukan' : 'Pengeluaran';
      bot.sendMessage(chatId, `✅ *${jenis} Dicatat!*\n📂 Kategori: ${transactionData.category}\n💵 Nominal: Rp${transactionData.amount.toLocaleString('id-ID')}\n📝 Keterangan: ${transactionData.description}`, { parse_mode: 'Markdown' });
    } else if (transactionData && transactionData.status === 'error') {
      bot.sendMessage(chatId, `🤔 ${transactionData.message}`);
    }

  } catch (error) {
    console.error('Error Global:', error);
    bot.sendMessage(chatId, "⚠️ Maaf, terjadi kesalahan pada sistem saat memproses datamu.");
  }
});