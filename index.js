require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const xlsx = require('xlsx'); // Tambahan library Excel

const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const allowedUserId = parseInt(process.env.ALLOWED_USER_ID, 10);

const userSessionTokens = {};

const masterInstruction = `
Kamu adalah asisten keuangan pribadi yang jenius. Baca pesan atau gambar dari user, lalu tentukan apa maksud (intent) user. 
Balas HANYA dengan satu objek JSON yang valid tanpa markdown teks tambahan.

Pilihan HANYA BOLEH salah satu dari "intent" ini:
1. "record" : Jika user memberikan data uang masuk/keluar atau foto struk.
2. "saldo"  : Jika user menanyakan sisa uang/saldo saat ini.
3. "report" : Jika user menanyakan total laporan bulan ini.
4. "analisa": Jika user meminta saran, evaluasi, atau curhat soal keuangannya.
5. "undo"   : Jika user minta membatalkan, menganulir, salah ketik, atau MENGHAPUS transaksi terakhir.
6. "riwayat": Jika user ingin melihat riwayat, daftar transaksi, atau history pengeluaran/pemasukan.
7. "export" : Jika user meminta data diunduh, dikirimkan file Excel, atau minta di-export.
8. "other"  : Jika user hanya menyapa atau ngobrol di luar konteks.

Format JSON Wajib:
{
  "intent": "record" | "saldo" | "report" | "analisa" | "undo" | "riwayat" | "export" | "other",
  "record_data": {
    "type": "income" | "expense",
    "amount": angka_tanpa_titik,
    "category": "string",
    "description": "string",
    "status": "success" | "error"
  },
  "reply": "Isi balasan ramah JIKA intent adalah 'other'."
}
`;

const analysisInstruction = `
Kamu adalah penasihat keuangan profesional. Analisis data transaksi berformat JSON berikut.
Berikan ringkasan, evaluasi arus kas, deteksi pemborosan, dan saran praktis. Gunakan bahasa Indonesia santai dan emoji.
`;

console.log('✅ Bot Asisten Keuangan Fleksibel + Excel Export menyala...');

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userText = msg.text || '';
  
  if (userId !== allowedUserId) return;

  if (!userSessionTokens[userId]) userSessionTokens[userId] = 0;

  bot.sendChatAction(chatId, 'typing');

  try {
    const masterModel = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      systemInstruction: masterInstruction,
      generationConfig: { responseMimeType: "application/json" }
    });

    let jsonResponseText = '';
    let promptTokens = 0;
    let replyTokens = 0;
    let currentTotalTokens = 0;

    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      const fileLink = await bot.getFileLink(photoId);
      const response = await fetch(fileLink);
      const arrayBuffer = await response.arrayBuffer();
      const base64Data = Buffer.from(arrayBuffer).toString('base64');
      const imagePart = { inlineData: { data: base64Data, mimeType: 'image/jpeg' } };
      
      const result = await masterModel.generateContent(["Apa maksud dari gambar ini? Jika ini struk, ekstrak.", imagePart]);
      jsonResponseText = result.response.text();
      
      promptTokens += result.response.usageMetadata?.promptTokenCount || 0;
      replyTokens += result.response.usageMetadata?.candidatesTokenCount || 0;
      currentTotalTokens += result.response.usageMetadata?.totalTokenCount || 0;
    } else if (userText) {
      const result = await masterModel.generateContent(userText);
      jsonResponseText = result.response.text();
      
      promptTokens += result.response.usageMetadata?.promptTokenCount || 0;
      replyTokens += result.response.usageMetadata?.candidatesTokenCount || 0;
      currentTotalTokens += result.response.usageMetadata?.totalTokenCount || 0;
    } else {
      return; 
    }

    const botDecision = JSON.parse(jsonResponseText);
    const intent = botDecision.intent;

    const generateTokenInfo = (extraTotal = 0) => {
      const finalInteractionTotal = currentTotalTokens + extraTotal;
      userSessionTokens[userId] += finalInteractionTotal;
      return `\n\n_🪙 Token: ${finalInteractionTotal} | Total sesi: ${userSessionTokens[userId]}_`;
    };

    if (intent === 'other') {
      const balasan = (botDecision.reply || "Halo! Ada yang bisa dibantu soal keuanganmu?") + generateTokenInfo();
      bot.sendMessage(chatId, balasan, { parse_mode: 'Markdown' });
    } 
    
    else if (intent === 'record') {
      const data = botDecision.record_data;
      if (data && data.status === 'success') {
        await supabase.from('transactions').insert([{
          user_id: userId, type: data.type, amount: data.amount,
          category: data.category, description: data.description
        }]);
        const jenis = data.type === 'income' ? 'Pemasukan' : 'Pengeluaran';
        bot.sendMessage(chatId, `✅ *${jenis} Dicatat!*\n📂 ${data.category}\n💵 Rp${data.amount.toLocaleString('id-ID')}\n📝 ${data.description}${generateTokenInfo()}`, { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(chatId, `🤔 Maaf, aku ga nemu nominal atau data yang jelas untuk dicatat.${generateTokenInfo()}`, { parse_mode: 'Markdown' });
      }
    } 
    
    else if (intent === 'saldo') {
      const { data, error } = await supabase.from('transactions').select('type, amount').eq('user_id', userId);
      if (error) throw error;
      let income = 0, expense = 0;
      data.forEach(t => { t.type === 'income' ? income += Number(t.amount) : expense += Number(t.amount); });
      const balance = income - expense;
      bot.sendMessage(chatId, `💰 *Sisa Uangmu Sekarang: Rp${balance.toLocaleString('id-ID')}*\n(Total Pemasukan: Rp${income.toLocaleString('id-ID')} | Pengeluaran: Rp${expense.toLocaleString('id-ID')})${generateTokenInfo()}`, { parse_mode: 'Markdown' });
    } 
    
    else if (intent === 'report') {
      const now = new Date();
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const { data, error } = await supabase.from('transactions').select('type, amount').eq('user_id', userId).gte('created_at', firstDay);
      if (error) throw error;
      let incMonth = 0, expMonth = 0;
      data.forEach(t => { t.type === 'income' ? incMonth += Number(t.amount) : expMonth += Number(t.amount); });
      bot.sendMessage(chatId, `📊 *Laporan Bulan Ini*\n🟢 Pemasukan: Rp${incMonth.toLocaleString('id-ID')}\n🔴 Pengeluaran: Rp${expMonth.toLocaleString('id-ID')}${generateTokenInfo()}`, { parse_mode: 'Markdown' });
    } 
    
    else if (intent === 'analisa') {
      bot.sendMessage(chatId, "⏳ Sebentar, aku baca catatan transaksimu bulan ini dulu ya...");
      const now = new Date();
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const { data, error } = await supabase.from('transactions').select('type, amount, category, description').eq('user_id', userId).gte('created_at', firstDay);
      if (error) throw error;
      
      if (data.length === 0) {
        bot.sendMessage(chatId, `Kamu belum mencatat apa-apa bulan ini, jadi belum bisa dianalisa nih!${generateTokenInfo()}`, { parse_mode: 'Markdown' });
        return;
      }

      const analysisModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash", systemInstruction: analysisInstruction });
      const prompt = `Ini dataku bulan ini: ${JSON.stringify(data)}. Tolong analisakan.`;
      const result = await analysisModel.generateContent(prompt);
      const extraT = result.response.usageMetadata?.totalTokenCount || 0;
      
      bot.sendMessage(chatId, result.response.text() + generateTokenInfo(extraT), { parse_mode: 'Markdown' });
    } 
    
    else if (intent === 'undo') {
      bot.sendMessage(chatId, "⏳ Mencari transaksi terakhirmu...");
      const { data, error } = await supabase.from('transactions').select('id, type, amount, category, description').eq('user_id', userId).order('created_at', { ascending: false }).limit(1);
      if (error) throw error;
      if (data.length === 0) {
        bot.sendMessage(chatId, `Belum ada transaksi apa pun yang bisa dihapus nih.${generateTokenInfo()}`, { parse_mode: 'Markdown' });
        return;
      }
      const latestTx = data[0];
      const { error: deleteError } = await supabase.from('transactions').delete().eq('id', latestTx.id);
      if (deleteError) throw deleteError;
      const jenis = latestTx.type === 'income' ? 'Pemasukan' : 'Pengeluaran';
      bot.sendMessage(chatId, `🗑️ *Transaksi Berhasil Dibatalkan!*\nData dihapus:\n\n❌ ${jenis}: ${latestTx.category}\n💵 Rp${latestTx.amount.toLocaleString('id-ID')}\n📝 ${latestTx.description}${generateTokenInfo()}`, { parse_mode: 'Markdown' });
    } 
    
    else if (intent === 'riwayat') {
      bot.sendMessage(chatId, "⏳ Mengambil data transaksi terakhir...");
      const { data, error } = await supabase.from('transactions').select('type, amount, category, description, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(10);
      if (error) throw error;

      if (data.length === 0) {
        bot.sendMessage(chatId, `Catatan transaksimu masih kosong.${generateTokenInfo()}`, { parse_mode: 'Markdown' });
        return;
      }

      let pesanRiwayat = "📜 *10 Transaksi Terakhirmu:*\n\n";
      data.forEach((t, index) => {
        const tanggal = new Date(t.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
        const emoji = t.type === 'income' ? '🟢' : '🔴';
        const tanda = t.type === 'income' ? '+' : '-';
        pesanRiwayat += `${index + 1}. ${emoji} *${t.category}* (${tanggal})\n   ${tanda}Rp${Number(t.amount).toLocaleString('id-ID')} - _${t.description}_\n\n`;
      });

      bot.sendMessage(chatId, pesanRiwayat + generateTokenInfo(), { parse_mode: 'Markdown' });
    }

    // --- FITUR BARU: EXPORT EXCEL ---
    else if (intent === 'export') {
      bot.sendMessage(chatId, "⏳ Menyiapkan file Excel dari seluruh riwayat transaksimu...");
      
      // Ambil seluruh data dari database
      const { data, error } = await supabase
        .from('transactions')
        .select('created_at, type, category, description, amount')
        .eq('user_id', userId)
        .order('created_at', { ascending: true }); // Diurutkan dari yang paling lama ke terbaru

      if (error) throw error;

      if (data.length === 0) {
        bot.sendMessage(chatId, `Belum ada transaksi yang bisa diexport nih.${generateTokenInfo()}`, { parse_mode: 'Markdown' });
        return;
      }

      // Rapikan data agar pas masuk ke kolom Excel
      const excelData = data.map((t, index) => ({
        'No': index + 1,
        'Tanggal': new Date(t.created_at).toLocaleString('id-ID'),
        'Tipe': t.type === 'income' ? 'Pemasukan' : 'Pengeluaran',
        'Kategori': t.category,
        'Keterangan': t.description,
        'Nominal (Rp)': Number(t.amount)
      }));

      // Proses pembuatan file Excel
      const worksheet = xlsx.utils.json_to_sheet(excelData);
      const workbook = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(workbook, worksheet, "Riwayat Transaksi");

      // Ubah Excel jadi buffer agar bisa langsung dikirim via Telegram tanpa harus disimpan di server VPS
      const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

      // Buat nama file dinamis berdasarkan tanggal hari ini
      const tanggalHariIni = new Date().toISOString().slice(0, 10); // Format YYYY-MM-DD
      const namaFile = `Laporan_Keuangan_${tanggalHariIni}.xlsx`;

      // Kirim dokumen langsung ke Telegram
      await bot.sendDocument(chatId, buffer, {
        caption: `✅ Selesai! Ini file Excel seluruh riwayat transaksi keuanganmu.${generateTokenInfo()}`,
        parse_mode: 'Markdown'
      }, {
        filename: namaFile,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
    }

    else {
      bot.sendMessage(chatId, `Maaf, aku bingung. Coba ketik dengan kalimat lain.${generateTokenInfo()}`, { parse_mode: 'Markdown' });
    }

  } catch (error) {
    console.error('Error Global:', error);
    bot.sendMessage(chatId, "⚠️ Waduh, ada sedikit gangguan di sistemku nih. Coba lagi ya.");
  }
});