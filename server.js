require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ============ НАСТРОЙКА CORS ============
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://karcher-front.vercel.app',
  'https://karcher-stolin.netlify.app'
];

const corsOptions = {
  origin: function (origin, callback) {
    // Разрешаем запросы без origin (например, Postman, мобильные приложения)
    if (!origin) return callback(null, true);
    
    // Проверяем, есть ли origin в списке разрешенных
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      // Логируем неизвестный origin, но разрешаем (для отладки)
      console.log('CORS: Запрос с неизвестным origin:', origin);
      // Для безопасности можно закомментировать следующую строку, чтобы блокировать неизвестные origin
      callback(null, true);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  exposedHeaders: ['Content-Length', 'X-Powered-By'],
  maxAge: 86400,
  preflightContinue: false,
  optionsSuccessStatus: 204
};

// Применяем CORS ко всем запросам (включая автоматическую обработку OPTIONS)
app.use(cors(corsOptions));

// ============ TELEGRAM BOT ============
let bot = null;
let userStates = {};
let sendBookingNotification = null;

if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ADMIN_CHAT_ID) {
  try {
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
    const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
    
    // Обработка ошибок polling
    bot.on('polling_error', (error) => {
      console.error('❌ Telegram polling error:', error.message);
      // Если конфликт (409), просто логируем - другой экземпляр работает
      if (error.code === 'ETELEGRAM' && error.message.includes('409')) {
        console.log('⚠️ Another bot instance is running. This instance will not poll.');
      }
    });
    
    console.log('🤖 Telegram bot initialized with button interface');

    const mainKeyboard = {
      reply_markup: {
        keyboard: [
          ['📋 Все бронирования', '📅 На сегодня'],
          ['➕ Добавить бронирование', '🗑️ Удалить брони'],
          ['👥 Клиенты', '📊 Статистика']
        ],
        resize_keyboard: true
      }
    };

    const servicesKeyboard = {
      reply_markup: {
        keyboard: [
          ['🧹 Пылесос Puzzi 8/1 C', '💨 Пароочиститель SC 4'],
          ['💦 Мойка K 5', '↩️ Назад']
        ],
        resize_keyboard: true
      }
    };

    const confirmKeyboard = {
      reply_markup: {
        keyboard: [
          ['✅ Подтвердить', '❌ Отменить']
        ],
        resize_keyboard: true
      }
    };

    const yesNoKeyboard = {
      reply_markup: {
        keyboard: [
          ['✅ Да', '❌ Нет']
        ],
        resize_keyboard: true
      }
    };

    const backKeyboard = {
      reply_markup: {
        keyboard: [
          ['↩️ Назад']
        ],
        resize_keyboard: true
      }
    };

    // === /start ===
    bot.onText(/\/start/, (msg) => {
      const chatId = msg.chat.id;
      const isAdmin = chatId.toString() === ADMIN_CHAT_ID;
      delete userStates[chatId];
      if (isAdmin) {
        bot.sendMessage(chatId,
          '👋 *Добро пожаловать в панель управления бронированиями!*\n\n' +
          'Выберите действие на клавиатуре ниже',
          {
            parse_mode: 'Markdown',
            ...mainKeyboard
          }
        );
      } else {
        bot.sendMessage(chatId,
          '👋 Привет! Я бот для управления бронированиями.\n\n' +
          'Чтобы получить доступ, свяжитесь с администратором.',
          { ...mainKeyboard }
        );
      }
    });

    // === Назад ===
    bot.onText(/↩️ Назад/, (msg) => {
      const chatId = msg.chat.id;
      delete userStates[chatId];
      bot.sendMessage(chatId, 'Главное меню:', { ...mainKeyboard });
    });

    // === Все бронирования ===
    bot.onText(/📋 Все бронирования/, async (msg) => {
      const chatId = msg.chat.id;
      if (chatId.toString() !== ADMIN_CHAT_ID) {
        bot.sendMessage(chatId, '⛔ Нет доступа', { ...backKeyboard });
        return;
      }
      try {
        const result = await pool.query(`
          SELECT b.*, c.first_name, c.last_name, c.phone_number
          FROM bookings b
          LEFT JOIN clients c ON b.client_id = c.id
          ORDER BY
            CASE
              WHEN b.service_name LIKE '%пылесоса%' THEN 1
              WHEN b.service_name LIKE '%пароочистителя%' THEN 2
              WHEN b.service_name LIKE '%мойки%' THEN 3
              ELSE 4
            END,
            b.booking_date DESC
        `);

        if (result.rows.length === 0) {
          bot.sendMessage(chatId, '📭 Нет активных бронирований', { ...backKeyboard });
          return;
        }

        const groupedBookings = {};
        result.rows.forEach(booking => {
          if (!groupedBookings[booking.service_name]) {
            groupedBookings[booking.service_name] = [];
          }
          groupedBookings[booking.service_name].push(booking);
        });

        let message = '📋 *Все бронирования по услугам:*\n\n';
        const serviceOrder = [
          'Аренда пылесоса Karcher Puzzi 8/1 C',
          'Аренда пароочистителя Karcher SC 4 Deluxe',
          'Аренда мойки высокого давления Karcher K 5 Full Control'
        ];

        serviceOrder.forEach(serviceName => {
          const bookings = groupedBookings[serviceName];
          if (bookings && bookings.length > 0) {
            let serviceEmoji = '🧹';
            if (serviceName.includes('пароочистителя')) serviceEmoji = '💨';
            if (serviceName.includes('мойки')) serviceEmoji = '💦';
            message += `${serviceEmoji} *${serviceName}:*\n`;
            bookings.forEach((booking, index) => {
              const date = new Date(booking.booking_date).toLocaleDateString('ru-RU');
              const address = booking.address ? `📍 ${booking.address}` : '';
              message += ` ${index + 1}. 📅 ${date} | 👤 ${booking.first_name || '-'} ${booking.last_name || ''} | 📞 ${booking.phone_number || '-'} | 🆔 *${booking.id}*\n`;
              if (address) message += `    ${address}\n`;
            });
            message += '\n';
          }
        });

        bot.sendMessage(chatId, message, {
          parse_mode: 'Markdown',
          ...backKeyboard
        });
      } catch (error) {
        console.error('Error:', error);
        bot.sendMessage(chatId, '❌ Ошибка при получении данных', { ...backKeyboard });
      }
    });

    // === На сегодня ===
    bot.onText(/📅 На сегодня/, async (msg) => {
      const chatId = msg.chat.id;
      if (chatId.toString() !== ADMIN_CHAT_ID) {
        bot.sendMessage(chatId, '⛔ Нет доступа', { ...backKeyboard });
        return;
      }
      try {
        const today = new Date().toISOString().split('T')[0];
        const result = await pool.query(`
          SELECT b.*, c.first_name, c.last_name, c.phone_number
          FROM bookings b
          LEFT JOIN clients c ON b.client_id = c.id
          WHERE DATE(b.booking_date) = $1
          ORDER BY b.booking_date
        `, [today]);

        if (result.rows.length === 0) {
          bot.sendMessage(chatId, `📅 *Сегодня (${today}) нет бронирований*`, {
            parse_mode: 'Markdown',
            ...backKeyboard
          });
          return;
        }

        let message = `📅 *Бронирования на сегодня (${today}):*\n\n`;
        result.rows.forEach((booking, index) => {
          const time = new Date(booking.booking_date).toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit'
          });
          const serviceEmoji = booking.service_name.includes('пылесоса') ? '🧹' :
            booking.service_name.includes('пароочистителя') ? '💨' : '💦';
          
          message += `*${index + 1}. ${serviceEmoji} ${booking.service_name}*\n`;
          message += ` ${time}\n`;
          message += ` 👤 ${booking.first_name || '-'} ${booking.last_name || ''}\n`;
          message += ` 📞 ${booking.phone_number || '-'}\n`;
          if (booking.address) message += ` 📍 ${booking.address}\n`;
          message += ` 🆔 *ID: ${booking.id}*\n\n`;
        });

        bot.sendMessage(chatId, message, {
          parse_mode: 'Markdown',
          ...backKeyboard
        });
      } catch (error) {
        bot.sendMessage(chatId, '❌ Ошибка', { ...backKeyboard });
      }
    });

    // === Добавить бронирование ===
    bot.onText(/➕ Добавить бронирование/, (msg) => {
      const chatId = msg.chat.id;
      if (chatId.toString() !== ADMIN_CHAT_ID) {
        bot.sendMessage(chatId, '⛔ Нет доступа', { ...backKeyboard });
        return;
      }
      userStates[chatId] = {
        step: 'service',
        data: {}
      };
      bot.sendMessage(chatId,
        '🎯 *Выберите услугу для бронирования:*',
        {
          parse_mode: 'Markdown',
          ...servicesKeyboard
        }
      );
    });

    // === Выбор услуги ===
    bot.onText(/🧹 Пылесос Puzzi 8\/1 C|💨 Пароочиститель SC 4|💦 Мойка K 5/, (msg) => {
      const chatId = msg.chat.id;
      const service = msg.text;
      if (!userStates[chatId] || userStates[chatId].step !== 'service') {
        bot.sendMessage(chatId, 'Начните с команды "➕ Добавить бронирование"', { ...backKeyboard });
        return;
      }
      const serviceMap = {
        '🧹 Пылесос Puzzi 8/1 C': 'Аренда пылесоса Karcher Puzzi 8/1 C',
        '💨 Пароочиститель SC 4': 'Аренда пароочистителя Karcher SC 4 Deluxe',
        '💦 Мойка K 5': 'Аренда мойки высокого давления Karcher K 5 Full Control'
      };
      userStates[chatId].data.service_name = serviceMap[service];
      userStates[chatId].step = 'date';
      bot.sendMessage(chatId,
        '📅 *Введите дату бронирования:*\n\n' +
        '_Формат: ДД.ММ.ГГГГ (например: 25.12.2024)_',
        {
          parse_mode: 'Markdown',
          reply_markup: { remove_keyboard: true }
        }
      );
    });

    // === Обработка ввода ===
    bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const text = msg.text;
      if (['📋 Все бронирования', '📅 На сегодня', '➕ Добавить бронирование',
        '🗑️ Удалить брони', '👥 Клиенты', '📊 Статистика', '↩️ Назад'].includes(text)) {
        return;
      }
      if (!userStates[chatId]) return;

      if (userStates[chatId].step === 'date' && !text.includes('↩️')) {
        const dateMatch = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
        if (!dateMatch) {
          bot.sendMessage(chatId,
            '❌ *Неверный формат даты!*\n\n' +
            'Введите в формате: *ДД.ММ.ГГГГ*\n' +
            'Пример: *25.12.2024*',
            { parse_mode: 'Markdown' }
          );
          return;
        }
        const [_, day, month, year] = dateMatch;
        const date = new Date(year, month - 1, day);
        if (isNaN(date.getTime())) {
          bot.sendMessage(chatId, '❌ Неверная дата!');
          return;
        }
        userStates[chatId].data.booking_date = date.toISOString();
        userStates[chatId].step = 'client_name';
        bot.sendMessage(chatId, '👤 *Введите имя клиента:*', { parse_mode: 'Markdown' });
      } else if (userStates[chatId].step === 'client_name') {
        userStates[chatId].data.client_name = text;
        userStates[chatId].step = 'client_phone';
        bot.sendMessage(chatId,
          '📞 *Введите телефон клиента:*\n\n' +
          '_Пример: +375291234567_',
          { parse_mode: 'Markdown' }
        );
      } else if (userStates[chatId].step === 'client_phone') {
        userStates[chatId].data.client_phone = text;
        userStates[chatId].step = 'client_address';
        bot.sendMessage(chatId,
          '📍 *Введите адрес доставки:*\n\n' +
          '_Пример: г. Минск, ул. Пушкина, д. 10, кв. 5_',
          { parse_mode: 'Markdown' }
        );
      } else if (userStates[chatId].step === 'client_address') {
        userStates[chatId].data.client_address = text;
        userStates[chatId].step = 'confirm';
        const date = new Date(userStates[chatId].data.booking_date);
        const dateStr = date.toLocaleDateString('ru-RU');
        bot.sendMessage(chatId,
          '📋 *Проверьте данные:*\n\n' +
          `*Услуга:* ${userStates[chatId].data.service_name}\n` +
          `*Дата:* ${dateStr}\n` +
          `*Клиент:* ${userStates[chatId].data.client_name}\n` +
          `*Телефон:* ${userStates[chatId].data.client_phone}\n` +
          `*Адрес:* ${userStates[chatId].data.client_address}\n\n` +
          'Все верно?',
          {
            parse_mode: 'Markdown',
            ...confirmKeyboard
          }
        );
      }
    });

    // === Подтверждение ===
    bot.onText(/✅ Подтвердить/, async (msg) => {
      const chatId = msg.chat.id;
      if (!userStates[chatId] || userStates[chatId].step !== 'confirm') {
        bot.sendMessage(chatId, 'Сессия истекла', { ...mainKeyboard });
        return;
      }
      const data = userStates[chatId].data;
      try {
        const uniqueSuffix = Date.now().toString().slice(-6) + Math.random().toString(36).slice(2, 5);
        const email = `client_${uniqueSuffix}@karcher.by`;
        const tempPassword = 'temp' + Math.random().toString(36).slice(-8);
        const hashedPassword = await bcrypt.hash(tempPassword, 10);

        const newClient = await pool.query(
          `INSERT INTO clients (first_name, last_name, phone_number, email, password_hash)
           VALUES ($1, '', $2, $3, $4)
           RETURNING id, first_name, last_name, phone_number`,
          [data.client_name, data.client_phone, email, hashedPassword]
        );

        const clientId = newClient.rows[0].id;

        const bookingResult = await pool.query(
          `INSERT INTO bookings (client_id, service_name, booking_date, address)
           VALUES ($1, $2, $3, $4)
           RETURNING id, client_id, service_name, booking_date, address`,
          [clientId, data.service_name, data.booking_date, data.client_address || null]
        );

        const dateStr = new Date(data.booking_date).toLocaleDateString('ru-RU');
        const booking = bookingResult.rows[0];

        bot.sendMessage(chatId,
          `✅ *Бронирование успешно создано!*\n\n` +
          `*Услуга:* ${data.service_name}\n` +
          `*Дата:* ${dateStr}\n` +
          `*Клиент:* ${data.client_name}\n` +
          `*Телефон:* ${data.client_phone}\n` +
          `*Адрес:* ${data.client_address || 'Не указан'}\n` +
          `*ID бронирования:* ${booking.id}`,
          {
            parse_mode: 'Markdown',
            ...mainKeyboard
          }
        );

        if (sendBookingNotification) {
          await sendBookingNotification(booking);
        }

        delete userStates[chatId];
      } catch (error) {
        console.error('Error adding booking:', error);
        bot.sendMessage(chatId,
          `❌ Ошибка при создании бронирования:\n${error.message}`,
          { ...mainKeyboard }
        );
        delete userStates[chatId];
      }
    });

    // === Отмена ===
    bot.onText(/❌ Отменить/, (msg) => {
      const chatId = msg.chat.id;
      delete userStates[chatId];
      bot.sendMessage(chatId, '❌ Действие отменено', { ...mainKeyboard });
    });

    // === Удалить бронирование ===
    bot.onText(/🗑️ Удалить брони/, (msg) => {
      const chatId = msg.chat.id;
      if (chatId.toString() !== ADMIN_CHAT_ID) {
        bot.sendMessage(chatId, '⛔ Нет доступа', { ...backKeyboard });
        return;
      }
      userStates[chatId] = { step: 'delete_ask_id' };
      bot.sendMessage(chatId,
        '🗑️ *Удаление бронирования*\n\n' +
        'Введите ID бронирования для удаления:',
        {
          parse_mode: 'Markdown',
          reply_markup: { remove_keyboard: true }
        }
      );
    });

    // === Обработка ID для удаления ===
    bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const text = msg.text;
      if (['📋 Все бронирования', '📅 На сегодня', '➕ Добавить бронирование',
        '🗑️ Удалить брони', '👥 Клиенты', '📊 Статистика', '↩️ Назад',
        '✅ Да', '❌ Нет', '✅ Подтвердить', '❌ Отменить'].includes(text)) {
        return;
      }
      if (userStates[chatId] && userStates[chatId].step === 'delete_ask_id') {
        const bookingId = parseInt(text);
        if (isNaN(bookingId)) {
          bot.sendMessage(chatId, '❌ Введите число (ID бронирования)', { ...mainKeyboard });
          delete userStates[chatId];
          return;
        }
        try {
          const checkResult = await pool.query(
            `SELECT b.*, c.first_name, c.last_name, c.phone_number
             FROM bookings b
             LEFT JOIN clients c ON b.client_id = c.id
             WHERE b.id = $1`,
            [bookingId]
          );
          if (checkResult.rows.length === 0) {
            bot.sendMessage(chatId,
              `❌ Бронирование с ID *${bookingId}* не найдено`,
              { parse_mode: 'Markdown', ...mainKeyboard }
            );
            delete userStates[chatId];
            return;
          }
          const booking = checkResult.rows[0];
          userStates[chatId].deleteCandidate = booking;
          const date = new Date(booking.booking_date).toLocaleDateString('ru-RU');
          bot.sendMessage(chatId,
            `⚠️ *Подтвердите удаление:*\n\n` +
            `*Услуга:* ${booking.service_name}\n` +
            `*Дата:* ${date}\n` +
            `*Клиент:* ${booking.first_name || '-'} ${booking.last_name || ''}\n` +
            `*Телефон:* ${booking.phone_number || '-'}\n` +
            (booking.address ? `*Адрес:* ${booking.address}\n` : '') +
            `*ID:* ${booking.id}\n\n` +
            `Удалить это бронирование?`,
            {
              parse_mode: 'Markdown',
              ...yesNoKeyboard
            }
          );
          userStates[chatId].step = 'confirm_delete';
        } catch (error) {
          console.error('Error checking booking:', error);
          bot.sendMessage(chatId, '❌ Ошибка при проверке бронирования', { ...mainKeyboard });
          delete userStates[chatId];
        }
      }
    });

    // === Подтверждение удаления ===
    bot.onText(/✅ Да/, async (msg) => {
      const chatId = msg.chat.id;
      if (!userStates[chatId] || userStates[chatId].step !== 'confirm_delete') {
        return;
      }
      try {
        const booking = userStates[chatId].deleteCandidate;
        const deleteResult = await pool.query('DELETE FROM bookings WHERE id = $1 RETURNING id', [booking.id]);
        if (deleteResult.rows.length === 0) {
          bot.sendMessage(chatId, '❌ Бронирование не найдено при удалении', { ...mainKeyboard });
          delete userStates[chatId];
          return;
        }
        const date = new Date(booking.booking_date).toLocaleDateString('ru-RU');
        bot.sendMessage(chatId,
          `✅ *Бронирование удалено!*\n\n` +
          `*Услуга:* ${booking.service_name}\n` +
          `*Дата:* ${date}\n` +
          `*Клиент:* ${booking.first_name || '-'} ${booking.last_name || ''}\n` +
          `*Телефон:* ${booking.phone_number || '-'}\n` +
          (booking.address ? `*Адрес:* ${booking.address}\n` : '') +
          `*ID:* ${booking.id}\n\n` +
          `Для обновления данных на сайте перезагрузите страницу`,
          {
            parse_mode: 'Markdown',
            ...mainKeyboard
          }
        );
        console.log(`✅ Бронирование ID ${booking.id} удалено через Telegram`);
      } catch (error) {
        console.error('Error deleting booking:', error);
        bot.sendMessage(chatId, '❌ Ошибка при удалении бронирования', { ...mainKeyboard });
      }
      delete userStates[chatId];
    });

    // === Отмена удаления ===
    bot.onText(/❌ Нет/, (msg) => {
      const chatId = msg.chat.id;
      if (userStates[chatId] && userStates[chatId].step === 'confirm_delete') {
        bot.sendMessage(chatId, '❌ Удаление отменено', { ...mainKeyboard });
        delete userStates[chatId];
      }
    });

    // === Клиенты ===
bot.onText(/👥 Клиенты/, async (msg) => {
  const chatId = msg.chat.id;
  if (chatId.toString() !== ADMIN_CHAT_ID) {
    bot.sendMessage(chatId, '⛔ Нет доступа', { ...backKeyboard });
    return;
  }
  try {
    const result = await pool.query(`
      SELECT c.*, COUNT(b.id) as booking_count
      FROM clients c
      LEFT JOIN bookings b ON c.id = b.client_id
      GROUP BY c.id
      ORDER BY c.id DESC
      LIMIT 10
    `);
    
    if (result.rows.length === 0) {
      bot.sendMessage(chatId, '👥 *Нет клиентов в базе*', {
        parse_mode: 'Markdown',
        ...backKeyboard
      });
      return;
    }
    
    let message = '👥 *Последние клиенты:*\n\n';
    result.rows.forEach((client, index) => {
      // Экранируем спецсимволы Markdown в данных клиентов
      const firstName = escapeMarkdown(client.first_name || '');
      const lastName = escapeMarkdown(client.last_name || '');
      const phoneNumber = escapeMarkdown(client.phone_number || '-');
      const email = escapeMarkdown(client.email || '-');
      
      message += `*${index + 1}. ${firstName} ${lastName}*\n`;
      message += `   📞 ${phoneNumber}\n`;
      message += `   📧 ${email}\n`;
      message += `   📊 Бронирований: ${client.booking_count}\n`;
      message += `   🆔 ID: ${client.id}\n\n`;
    });
    
    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      ...backKeyboard
    });
    
  } catch (error) {
    console.error('❌ Error fetching clients:', error);
    bot.sendMessage(chatId, '❌ Ошибка при получении данных клиентов', { ...backKeyboard });
  }
});

// Функция для экранирования спецсимволов Markdown
function escapeMarkdown(text) {
  if (!text) return text;
  return text.toString()
    .replace(/_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/~/g, '\\~')
    .replace(/`/g, '\\`')
    .replace(/>/g, '\\>')
    .replace(/#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/-/g, '\\-')
    .replace(/=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\./g, '\\.')
    .replace(/!/g, '\\!');
}

    // === Статистика ===
    bot.onText(/📊 Статистика/, async (msg) => {
      const chatId = msg.chat.id;
      if (chatId.toString() !== ADMIN_CHAT_ID) {
        bot.sendMessage(chatId, '⛔ Нет доступа', { ...backKeyboard });
        return;
      }
      try {
        const today = new Date().toISOString().split('T')[0];
        const [todayStats, monthStats, popularServices, totalClients] = await Promise.all([
          pool.query('SELECT COUNT(*) FROM bookings WHERE DATE(booking_date) = $1', [today]),
          pool.query("SELECT COUNT(*) FROM bookings WHERE DATE_TRUNC('month', booking_date) = DATE_TRUNC('month', CURRENT_DATE)"),
          pool.query('SELECT service_name, COUNT(*) as count FROM bookings GROUP BY service_name ORDER BY count DESC LIMIT 5'),
          pool.query('SELECT COUNT(*) FROM clients')
        ]);

        const message =
          '📊 *Статистика бронирований:*\n\n' +
          `📅 *Сегодня:* ${todayStats.rows[0].count}\n` +
          `📈 *Этот месяц:* ${monthStats.rows[0].count}\n` +
          `👥 *Всего клиентов:* ${totalClients.rows[0].count}\n\n` +
          '*Популярные услуги:*\n' +
          popularServices.rows.map((service, index) =>
            `${index + 1}. ${service.service_name}: ${service.count}`
          ).join('\n');

        bot.sendMessage(chatId, message, {
          parse_mode: 'Markdown',
          ...backKeyboard
        });
      } catch (error) {
        console.error('Error fetching stats:', error);
        bot.sendMessage(chatId, '❌ Ошибка', { ...backKeyboard });
      }
    });

    // === Уведомление о новом бронировании ===
    sendBookingNotification = async (bookingData) => {
      try {
        const clientInfo = await pool.query(
          'SELECT first_name, last_name, phone_number FROM clients WHERE id = $1',
          [bookingData.client_id]
        );
        let clientName = 'Не указан';
        let clientPhone = 'Не указан';
        if (clientInfo.rows.length > 0) {
          const client = clientInfo.rows[0];
          clientName = `${client.first_name || ''} ${client.last_name || ''}`.trim() || 'Не указан';
          clientPhone = client.phone_number || 'Не указан';
        }
        const date = new Date(bookingData.booking_date).toLocaleDateString('ru-RU');
        const time = new Date().toLocaleTimeString('ru-RU');
        const message =
          `🆕 *Новое бронирование!*\n\n` +
          `*Услуга:* ${bookingData.service_name}\n` +
          `*Дата:* ${date}\n` +
          `*Клиент:* ${clientName}\n` +
          `*Телефон:* ${clientPhone}\n` +
          `*Адрес:* ${bookingData.address || 'Не указан'}\n` +
          `*Время создания:* ${time}\n` +
          `*ID:* ${bookingData.id}`;
        await bot.sendMessage(ADMIN_CHAT_ID, message, {
          parse_mode: 'Markdown',
          ...mainKeyboard
        });
        console.log('✅ Telegram notification sent for booking ID:', bookingData.id);
      } catch (error) {
        console.error('❌ Error sending Telegram notification:', error.message);
      }
    };

    console.log('✅ Telegram bot ready with button interface');
  } catch (error) {
    console.error('❌ Error initializing Telegram bot:', error.message);
  }
} else {
  console.log('⚠️ Telegram bot token or admin chat ID not configured');
}

// ============ СЕРВЕР ============
const saltRounds = 10;

app.use(express.json());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  console.log('Origin:', origin);
  console.log('Allowed origins:', allowedOrigins);
  if (origin && allowedOrigins.includes(origin)) {
    console.log('✅ Origin разрешен');
  } else if (origin) {
    console.log('⚠️ Origin не в списке разрешенных');
  }
  next();
});

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// GET /clients
app.get('/clients', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, first_name, last_name, email, phone_number, address FROM clients ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching clients:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// POST /clients (регистрация)
app.post('/clients', async (req, res) => {
  const { first_name, last_name, email, phone_number, address, password } = req.body;
  if (!first_name || !last_name || !email || !password) {
    return res.status(400).json({
      error: 'Missing required fields: first_name, last_name, email, password'
    });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const result = await pool.query(
      `INSERT INTO clients (first_name, last_name, email, phone_number, address, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, first_name, last_name, email, phone_number`,
      [first_name, last_name, email, phone_number, address, hashedPassword]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'clients_email_key') {
      return res.status(409).json({ error: 'Email already exists.' });
    }
    console.error('Error adding client:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// GET /clients/search
app.get('/clients/search', async (req, res) => {
  const { phone } = req.query;
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  try {
    const result = await pool.query(
      'SELECT id, first_name, last_name, phone_number FROM clients WHERE phone_number = $1 LIMIT 1',
      [phone]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error searching client:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// POST /login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  try {
    const user = await pool.query(
      'SELECT id, first_name, last_name, email, password_hash FROM clients WHERE email = $1',
      [email]
    );
    if (user.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const client = user.rows[0];
    const passwordMatch = await bcrypt.compare(password, client.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    delete client.password_hash;
    res.json({ message: 'Login successful', client });
  } catch (err) {
    console.error('Error during login:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// POST /find-or-create-client
app.post('/find-or-create-client', async (req, res) => {
  console.log('Создание нового клиента:', req.body);
  const { first_name, last_name, phone_number } = req.body;
  if (!first_name || !phone_number) {
    return res.status(400).json({
      error: 'Имя и телефон обязательны'
    });
  }
  try {
    const uniqueSuffix = Date.now().toString().slice(-6) + Math.random().toString(36).slice(2, 5);
    const email = `client_${uniqueSuffix}@karcher.by`;
    const tempPassword = 'temp' + Math.random().toString(36).slice(-8);
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    const newClient = await pool.query(
      `INSERT INTO clients (first_name, last_name, phone_number, email, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, first_name, last_name, phone_number`,
      [first_name, last_name || '', phone_number, email, hashedPassword]
    );
    const clientId = newClient.rows[0].id;
    console.log('✅ Создан новый клиент ID:', clientId, 'Имя:', first_name, 'Телефон:', phone_number);
    res.status(200).json({
      client_id: clientId,
      is_new: true,
      message: 'Создан новый клиент'
    });
  } catch (err) {
    console.error('Ошибка при создании клиента:', err);
    if (err.code === '23505' && err.constraint === 'clients_email_key') {
      const fallbackEmail = `client_${Date.now()}${Math.random().toString(36).slice(2)}@karcher.by`;
      const fallbackHashedPassword = await bcrypt.hash('temp' + Math.random().toString(36).slice(-8), 10);
      try {
        const fallbackClient = await pool.query(
          `INSERT INTO clients (first_name, last_name, phone_number, email, password_hash)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [first_name, last_name || '', phone_number, fallbackEmail, fallbackHashedPassword]
        );
        res.status(200).json({
          client_id: fallbackClient.rows[0].id,
          is_new: true,
          message: 'Создан новый клиент (fallback)'
        });
      } catch (fallbackErr) {
        console.error('Ошибка при создании клиента (fallback):', fallbackErr);
        res.status(500).json({
          error: 'Ошибка сервера',
          details: fallbackErr.message
        });
      }
    } else {
      res.status(500).json({
        error: 'Ошибка сервера',
        details: err.message
      });
    }
  }
});

// POST /bookings
app.post('/bookings', async (req, res) => {
  console.log('POST /bookings запрос:', req.body);
  const { client_id, service_name, booking_date, address } = req.body;
  if (!client_id || !service_name || !booking_date) {
    console.error('❌ Отсутствуют обязательные поля:', { client_id, service_name, booking_date });
    return res.status(400).json({
      error: 'Отсутствуют обязательные поля: client_id, service_name, booking_date'
    });
  }
  try {
    console.log('Проверяем клиента ID:', client_id);
    const clientCheck = await pool.query(
      'SELECT id FROM clients WHERE id = $1',
      [client_id]
    );
    if (clientCheck.rows.length === 0) {
      console.error('❌ Клиент не найден:', client_id);
      return res.status(404).json({
        error: 'Клиент не найден'
      });
    }
    console.log('✅ Клиент найден, создаем бронирование...');
    const result = await pool.query(
      `INSERT INTO bookings (client_id, service_name, booking_date, address)
       VALUES ($1, $2, $3, $4)
       RETURNING id, client_id, service_name, booking_date, address`,
      [client_id, service_name, booking_date, address || null]
    );
    const booking = result.rows[0];
    console.log('✅ Бронирование создано:', booking);
    if (bot && sendBookingNotification) {
      try {
        await sendBookingNotification(booking);
        console.log('✅ Уведомление отправлено в Telegram');
      } catch (tgError) {
        console.error('⚠️ Ошибка Telegram уведомления:', tgError.message);
      }
    }
    res.status(201).json(booking);
  } catch (err) {
    console.error('❌ Ошибка при создании бронирования:', err);
    console.error('❌ Детали ошибки:', {
      code: err.code,
      message: err.message
    });
    res.status(500).json({
      error: 'Внутренняя ошибка сервера',
      message: err.message
    });
  }
});

// GET /bookings
app.get('/bookings', async (req, res) => {
  try {
    const { serviceName } = req.query;
    let query = `
      SELECT
        b.id,
        b.service_name,
        b.booking_date,
        b.address,
        b.created_at,
        b.updated_at,
        c.id AS client_id,
        c.first_name AS client_first_name,
        c.last_name AS client_last_name,
        c.email AS client_email,
        c.phone_number AS client_phone
      FROM bookings b
      JOIN clients c ON b.client_id = c.id
    `;
    const queryParams = [];
    if (serviceName) {
      query += ` WHERE b.service_name ILIKE $1`;
      queryParams.push(`%${serviceName}%`);
    }
    query += ` ORDER BY b.booking_date DESC`;
    const result = await pool.query(query, queryParams);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching bookings:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// GET /comments
app.get('/comments', async (req, res) => {
  try {
    console.log('Получение комментариев из базы данных');
    const result = await pool.query(`
      SELECT id, client_id, author_name, comment_text,
             TO_CHAR(created_at, 'DD.MM.YYYY') as created_at,
             rating
      FROM comments
      WHERE is_approved = true
      ORDER BY created_at DESC
    `);
    console.log(`Найдено ${result.rows.length} комментариев`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching comments:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /comments
app.post('/comments', async (req, res) => {
  const { client_id, comment_text, author_name, rating } = req.body;
  console.log('POST /comments запрос:', req.body);
  if (!comment_text || comment_text.trim().length === 0) {
    return res.status(400).json({ error: 'Текст комментария обязателен' });
  }
  if (rating && (rating < 1 || rating > 5)) {
    return res.status(400).json({ error: 'Рейтинг должен быть от 1 до 5' });
  }
  try {
    if (client_id) {
      const existingComment = await pool.query(
        'SELECT id FROM comments WHERE client_id = $1 LIMIT 1',
        [client_id]
      );
      if (existingComment.rows.length > 0) {
        return res.status(400).json({
          error: 'Вы уже оставляли комментарий. Удалите старый чтобы добавить новый.'
        });
      }
    }
    const result = await pool.query(
      `INSERT INTO comments (client_id, author_name, comment_text, rating, is_approved)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, client_id, author_name, comment_text,
                 TO_CHAR(created_at, 'DD.MM.YYYY') as created_at, rating`,
      [client_id || null, author_name || 'Аноним', comment_text.trim(), rating || null]
    );
    console.log('Комментарий добавлен с ID:', result.rows[0].id);
    res.status(201).json({
      ...result.rows[0],
      message: 'Комментарий успешно добавлен!'
    });
  } catch (err) {
    console.error('Error adding comment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /comments/:id
app.delete('/comments/:id', async (req, res) => {
  const { id } = req.params;
  console.log('DELETE /comments запрос для ID:', id);
  try {
    const result = await pool.query(
      'DELETE FROM comments WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Комментарий не найден' });
    }
    console.log('Комментарий удален с ID:', result.rows[0].id);
    res.json({
      message: 'Комментарий удален',
      deletedId: result.rows[0].id
    });
  } catch (err) {
    console.error('Error deleting comment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /all-bookings-by-service
app.get('/all-bookings-by-service', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        b.service_name,
        DATE(b.booking_date) as booking_date,
        COUNT(*) as booking_count
      FROM bookings b
      GROUP BY b.service_name, DATE(b.booking_date)
      ORDER BY
        CASE
          WHEN b.service_name LIKE '%пылесоса%' THEN 1
          WHEN b.service_name LIKE '%пароочистителя%' THEN 2
          WHEN b.service_name LIKE '%мойки%' THEN 3
          ELSE 4
        END,
        DATE(b.booking_date) DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching all bookings by service:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// GET /availability-by-date
app.get('/availability-by-date', async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: 'Date parameter is required' });
  }
  try {
    const result = await pool.query(`
      SELECT
        b.service_name,
        COUNT(*) as count
      FROM bookings b
      WHERE DATE(b.booking_date) = $1
      GROUP BY b.service_name
    `, [date]);
    const limits = {
      'Аренда пылесоса Karcher Puzzi 8/1 C': 2,
      'Аренда пароочистителя Karcher SC 4 Deluxe': 1,
      'Аренда мойки высокого давления Karcher K 5 Full Control': 1
    };
    const availability = {};
    Object.keys(limits).forEach(service => {
      availability[service] = {
        current: 0,
        limit: limits[service],
        available: true
      };
    });
    result.rows.forEach(row => {
      if (availability[row.service_name]) {
        availability[row.service_name].current = parseInt(row.count);
        availability[row.service_name].available = parseInt(row.count) < availability[row.service_name].limit;
      }
    });
    res.json({
      date: date,
      availability: availability
    });
  } catch (err) {
    console.error('Error checking availability by date:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// GET /check-availability
app.get('/check-availability', async (req, res) => {
  const { service_id, date } = req.query;
  try {
    const result = await pool.query(`
      SELECT COUNT(*) as booking_count
      FROM bookings
      WHERE service_name = $1
        AND DATE(booking_date) = $2
    `, [service_id, date]);
    const limits = {
      'Аренда пылесоса Karcher Puzzi 8/1 C': 2,
      'Аренда пароочистителя Karcher SC 4 Deluxe': 1,
      'Аренда мойки высокого давления Karcher K 5 Full Control': 1
    };
    const limit = limits[service_id] || 1;
    const count = parseInt(result.rows[0].booking_count);
    res.json({
      available: count < limit,
      current: count,
      limit: limit,
      date: date
    });
  } catch (err) {
    console.error('Error checking availability:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// PUT /clients/:id
app.put('/clients/:id', async (req, res) => {
  const { id } = req.params;
  const { first_name, last_name, email, phone_number, address } = req.body;
  try {
    const result = await pool.query(
      'UPDATE clients SET first_name = $1, last_name = $2, email = $3, phone_number = $4, address = $5 WHERE id = $6 RETURNING id, first_name, last_name, email',
      [first_name, last_name, email, phone_number, address, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'clients_email_key') {
      return res.status(409).json({ error: 'Email already exists for another client.' });
    }
    console.error(`Error updating client with ID ${id}:`, err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// DELETE /clients/:id
app.delete('/clients/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM clients WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }
    res.status(204).send();
  } catch (err) {
    if (err.code === '23503' && err.constraint === 'bookings_client_id_fkey') {
      return res.status(409).json({ error: 'Cannot delete client with existing bookings.' });
    }
    console.error(`Error deleting client with ID ${id}:`, err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// GET /bookings/:id
app.get('/bookings/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`
      SELECT
        b.id,
        b.service_name,
        b.booking_date,
        b.address,
        b.created_at,
        b.updated_at,
        c.id AS client_id,
        c.first_name AS client_first_name,
        c.last_name AS client_last_name,
        c.email AS client_email
      FROM bookings b
      JOIN clients c ON b.client_id = c.id
      WHERE b.id = $1
    `, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`Error fetching booking with ID ${id}:`, err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// GET /clients/:id/bookings
app.get('/clients/:id/bookings', async (req, res) => {
  const { id } = req.params;
  try {
    const clientCheck = await pool.query('SELECT id FROM clients WHERE id = $1', [id]);
    if (clientCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }
    const result = await pool.query(`
      SELECT
        b.id,
        b.service_name,
        b.booking_date,
        b.address,
        b.created_at,
        b.updated_at
      FROM bookings b
      WHERE b.client_id = $1
      ORDER BY b.booking_date DESC
    `, [id]);
    res.json(result.rows);
  } catch (err) {
    console.error(`Error fetching bookings for client ID ${id}:`, err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// PUT /bookings/:id
app.put('/bookings/:id', async (req, res) => {
  const { id } = req.params;
  const { client_id, service_name, booking_date, address } = req.body;
  try {
    let updateQuery = 'UPDATE bookings SET service_name = $1, booking_date = $2, updated_at = CURRENT_TIMESTAMP';
    const queryParams = [service_name, booking_date];
    let paramIndex = 3;
    if (client_id !== undefined) {
      const clientExists = await pool.query('SELECT id FROM clients WHERE id = $1', [client_id]);
      if (clientExists.rows.length === 0) {
        return res.status(404).json({ error: 'New client_id not found.' });
      }
      updateQuery += `, client_id = $${paramIndex}`;
      queryParams.push(client_id);
      paramIndex++;
    }
    if (address !== undefined) {
      updateQuery += `, address = $${paramIndex}`;
      queryParams.push(address);
      paramIndex++;
    }
    updateQuery += ` WHERE id = $${paramIndex} RETURNING id, client_id, service_name, booking_date, address`;
    queryParams.push(id);
    const result = await pool.query(updateQuery, queryParams);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`Error updating booking with ID ${id}:`, err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// DELETE /bookings/:id
app.delete('/bookings/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM bookings WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    res.status(204).send();
  } catch (err) {
    console.error(`Error deleting booking with ID ${id}:`, err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// GET /check-duplicate-client
app.get('/check-duplicate-client', async (req, res) => {
  const { phone } = req.query;
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  try {
    const result = await pool.query(
      `SELECT c.id, c.first_name, c.last_name, c.phone_number,
                      COUNT(b.id) as booking_count
               FROM clients c
               LEFT JOIN bookings b ON c.id = b.client_id
               WHERE c.phone_number = $1
               GROUP BY c.id
               ORDER BY c.created_at DESC
               LIMIT 5`,
      [phone]
    );
    res.json({
      exists: result.rows.length > 0,
      clients: result.rows,
      count: result.rows.length
    });
  } catch (err) {
    console.error('Error checking duplicate client:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// GET /
app.get('/', (req, res) => {
  res.json({
    message: 'Karcher Booking API',
    version: '1.0.0',
    status: 'running',
    endpoints: [
      '/clients',
      '/bookings',
      '/comments',
      '/availability-by-date',
      '/all-bookings-by-service'
    ]
  });
});

// GET /health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    cors: 'enabled',
    origins: allowedOrigins
  });
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to PostgreSQL:', err.stack);
  } else {
    console.log('Connected to PostgreSQL database (Neon)!');
    release();
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`CORS enabled for origins: ${allowedOrigins.join(', ')}`);
  if (bot) {
    console.log(`Telegram bot with buttons is active`);
  }
});

// ============ КОРРЕКТНОЕ ЗАВЕРШЕНИЕ ПРОЦЕССА ============
const gracefulShutdown = (signal) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  
  if (bot) {
    try {
      bot.stopPolling();
      console.log('✅ Telegram bot polling stopped');
    } catch (error) {
      console.error('Error stopping bot polling:', error.message);
    }
  }
  
  pool.end(() => {
    console.log('✅ PostgreSQL connection pool closed');
    process.exit(0);
  });
  
  // Принудительное завершение через 10 секунд, если graceful shutdown не удался
  setTimeout(() => {
    console.error('⚠️ Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = pool;