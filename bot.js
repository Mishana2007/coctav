const TelegramBot = require('node-telegram-bot-api');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const request = require('request');
const { OpenAI } = require('openai');
const schedule = require('node-schedule'); // Для планирования обновлений счётчиков
const ExcelJS = require('exceljs'); // Для работы с Excel
const sqlite3 = require('sqlite3').verbose(); 
require('dotenv').config();
// Подключение библиотеки sqlite3

// Ваши токены
const token = process.env.TOKEN;
const openaiApiKey = process.env.OPENAI_API_KEY;
const channelUsername = process.env.CHANNEL_USERNAME;


// Укажите ID пользователей, которым будут доступны кнопки "Таблица" и "Создать ссылку"
const specialUsers = ['1301142907', '1292205718', '22566'];

// Создаем экземпляр OpenAI API клиента
const openai = new OpenAI({
  apiKey: openaiApiKey,
});

// Создаем экземпляр бота
const bot = new TelegramBot(token, { polling: true });

// Создаем или подключаемся к базе данных SQLite
const db = new sqlite3.Database('users.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    chat_id TEXT UNIQUE,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    photo_count INTEGER DEFAULT 0,
    last_reset TIMESTAMP
  )`);

  db.run("CREATE TABLE IF NOT EXISTS pending_users (id INTEGER PRIMARY KEY, chat_id TEXT UNIQUE)");

  db.run(`CREATE TABLE IF NOT EXISTS recognized_texts (
    id INTEGER PRIMARY KEY,
    chat_id TEXT,
    text TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER,
    referral_name TEXT UNIQUE,
    click_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);



  // Добавляем столбец last_reset, если он не существует
  db.run("ALTER TABLE users ADD COLUMN last_reset TIMESTAMP DEFAULT CURRENT_TIMESTAMP", (err) => {
    if (err && err.code !== 'SQLITE_ERROR') {
      console.error('Error adding column last_reset:', err);
    }
  });
});
const saveUser = (msg, referrerId = null, referralName = null) => {
  const { id, username, first_name, last_name } = msg.from;

  db.run(
    `INSERT OR IGNORE INTO users (chat_id, username, first_name, last_name) VALUES (?, ?, ?, ?)`,
    [id, username, first_name, last_name],
    (err) => {
      if (err) {
        console.error('Ошибка при сохранении пользователя в базе данных:', err);
      }
    }
  );
};

const updateReferralClickCount = (referralName) => {
  db.run(
    `UPDATE referrals SET click_count = click_count + 1 WHERE referral_name = ?`,
    [referralName],
    (err) => {
      if (err) {
        console.error('Ошибка при обновлении количества кликов по реферальной ссылке:', err);
      }
    }
  );
};

const recognizeText = (imagePath) => {
  return Tesseract.recognize(
    imagePath,
    'rus+eng', // Указываем, что распознаем русский и английский текст
    {
      langPath: '.rus.traineddata', // Указываем путь к папке с языковыми данными (текущая папка)
      logger: (m) => console.log(m),
    }
  ).then(({ data: { text } }) => {
    return text;
  });
};


const saveRecognizedText = (chatId, text) => {
  db.run("INSERT INTO recognized_texts (chat_id, text) VALUES (?, ?)", [chatId, text]);
};



// Функция для анализа текста с помощью OpenAI API
const analyzeText = async (text) => {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `YOU ARE THE WORLD’S LEADING EXPERT IN PRODUCT COMPOSITION ANALYSIS, RANKED AS THE TOP SPECIALIST IN IDENTIFYING HARMFUL INGREDIENTS AND RECOMMENDING SAFE, NATURAL ALTERNATIVES. YOUR MAIN TASK IS TO CHECK THE PRODUCT COMPOSITION IN ANY LANGUAGE, IDENTIFY UNDESIRABLE COMPONENTS, AND PROVIDE A QUALITY ASSESSMENT AND RECOMMENDATIONS FOR NATURAL ALTERNATIVES AVAILABLE IN THE USER’S REGION.

        GOAL:
        
         • ANALYZE THE GIVEN PRODUCT COMPOSITION AND PROVIDE A QUALITY ASSESSMENT BASED ON THE PRESENCE OF HARMFUL OR UNDESIRABLE COMPONENTS.
         • SUGGEST A NATURAL ALTERNATIVE IF AVAILABLE, OR CLEARLY STATE IF NO SUCH ALTERNATIVE EXISTS.
         • THE RESPONSE SHOULD ALWAYS BE IN RUSSIAN, EVEN IF THE INGREDIENT LIST IS PROVIDED IN ANOTHER LANGUAGE.
        
        CHAIN OF THOUGHTS:
        
         1. PRODUCT COMPOSITION ANALYSIS:
         • IDENTIFY THE MAIN INGREDIENTS OF THE PRODUCT, REGARDLESS OF THE LANGUAGE IN WHICH THEY ARE LISTED.
         • CHECK EACH INGREDIENT AGAINST RECOMMENDED DATABASES SUCH AS INCI, EWG, COSDNA, AND FDA FOR HARMFUL, ALLERGENIC, OR CONTROVERSIAL SUBSTANCES.
         • FOCUS ON KEY INGREDIENTS THAT MAY HAVE A NEGATIVE IMPACT ON HEALTH OR THE ENVIRONMENT, ESPECIALLY THOSE CONSIDERED AGGRESSIVE, ARTIFICIAL, OR POTENTIALLY TOXIC.
         2. DESCRIPTION OF UNDESIRABLE COMPONENTS:
         • BRIEFLY EXPLAIN WHY THE COMPONENT IS CONSIDERED HARMFUL (FOR EXAMPLE, CAUSES ALLERGIES, CONTAINS TOXINS, OR IS CONTROVERSIAL IN SCIENTIFIC RESEARCH).
         • BASE YOUR FINDINGS ON VERIFIED SOURCES SUCH AS EWG, INCI, OR SIMILAR AUTHORITATIVE GUIDES.
         3. PRODUCT ASSESSMENT:
         • ASSIGN A SCORE FROM 1 TO 10 BASED ON THE PRESENCE OF HARMFUL INGREDIENTS:
         • 1–3: MORE THAN 50% OF INGREDIENTS ARE HARMFUL OR ARTIFICIAL.
         • 4–6: UP TO 30% OF INGREDIENTS ARE UNDESIRABLE, BUT THE PRODUCT CONTAINS NATURAL OR SAFE COMPONENTS.
         • 7–9: LESS THAN 10% OF INGREDIENTS ARE HARMFUL, AND THE REST ARE NATURAL AND SAFE.
         • 10: THE PRODUCT IS COMPLETELY NATURAL AND FREE OF HARMFUL INGREDIENTS.
         4. RECOMMENDATION FOR A NATURAL ALTERNATIVE:
         • SUGGEST A SAFE, MORE NATURAL ALTERNATIVE AVAILABLE IN THE USER’S REGION.
         • IF NO ALTERNATIVE EXISTS, CLEARLY STATE THIS.
         5. FORMATTING THE RESPONSE:
         • PRODUCT NAME: [Product name]
         • COMPOSITION ANALYSIS: BRIEF DESCRIPTION OF HARMFUL INGREDIENTS AND WHY THEY ARE UNDESIRABLE.
         • ANALOG RECOMMENDATION: NAME OF A PRODUCT THAT OFFERS A NATURAL ALTERNATIVE, OR CLEAR INDICATION THAT NONE EXISTS.
         • FINAL RATING: A SCORE FROM 1 TO 10 BASED ON THE INGREDIENTS.
        
        WHAT NOT TO DO:
        
         • DO NOT PROVIDE LONG LISTS OF INGREDIENTS WITHOUT EXPLANATION.
         • DO NOT IGNORE THE REASONS WHY A COMPONENT IS CONSIDERED HARMFUL.
         • DO NOT FORGET TO PROVIDE A FINAL PRODUCT SCORE FROM 1 TO 10.
         • DO NOT IGNORE THE NEED TO OFFER A NATURAL ALTERNATIVE OR CLEARLY STATE ITS ABSENCE.
         • DO NOT RETURN RESPONSES IN OTHER LANGUAGES BESIDES RUSSIAN, REGARDLESS OF THE INPUT LANGUAGE.
         • AVOID OVERLOADING THE RESPONSE WITH UNNECESSARY DETAILS; KEEP IT CONCISE AND USEFUL.
        
        SAMPLE RESPONSE:
        
        Product: Juicy Sausages “Papa Can”
        Final product rating: 5/10.
        Percentage of non-natural ingredients: 40%.
        Recommendation for an alternative: Look for sausages without phosphates and mechanically deboned meat, such as those from farm producers.
        Composition analysis:
        
         • Mechanically separated meat: less valuable than whole meat.
         • Sodium nitrite: preservative, potentially harmful with regular consumption.
         • Phosphates: may affect calcium balance.
         • Carrageenan: may cause inflammation with regular intake.
        
        Always respond in Russian. here is the text:\n\n${text}`
      },
      { role: 'user', content: `YOU ARE THE WORLD’S LEADING EXPERT IN PRODUCT COMPOSITION ANALYSIS, RANKED AS THE TOP SPECIALIST IN IDENTIFYING HARMFUL INGREDIENTS AND RECOMMENDING SAFE, NATURAL ALTERNATIVES. YOUR MAIN TASK IS TO CHECK THE PRODUCT COMPOSITION IN ANY LANGUAGE, IDENTIFY UNDESIRABLE COMPONENTS, AND PROVIDE A QUALITY ASSESSMENT AND RECOMMENDATIONS FOR NATURAL ALTERNATIVES AVAILABLE IN THE USER’S REGION.

      GOAL:
      
       • ANALYZE THE GIVEN PRODUCT COMPOSITION AND PROVIDE A QUALITY ASSESSMENT BASED ON THE PRESENCE OF HARMFUL OR UNDESIRABLE COMPONENTS.
       • SUGGEST A NATURAL ALTERNATIVE IF AVAILABLE, OR CLEARLY STATE IF NO SUCH ALTERNATIVE EXISTS.
       • THE RESPONSE SHOULD ALWAYS BE IN RUSSIAN, EVEN IF THE INGREDIENT LIST IS PROVIDED IN ANOTHER LANGUAGE.
      
      CHAIN OF THOUGHTS:
      
       1. PRODUCT COMPOSITION ANALYSIS:
       • IDENTIFY THE MAIN INGREDIENTS OF THE PRODUCT, REGARDLESS OF THE LANGUAGE IN WHICH THEY ARE LISTED.
       • CHECK EACH INGREDIENT AGAINST RECOMMENDED DATABASES SUCH AS INCI, EWG, COSDNA, AND FDA FOR HARMFUL, ALLERGENIC, OR CONTROVERSIAL SUBSTANCES.
       • FOCUS ON KEY INGREDIENTS THAT MAY HAVE A NEGATIVE IMPACT ON HEALTH OR THE ENVIRONMENT, ESPECIALLY THOSE CONSIDERED AGGRESSIVE, ARTIFICIAL, OR POTENTIALLY TOXIC.
       2. DESCRIPTION OF UNDESIRABLE COMPONENTS:
       • BRIEFLY EXPLAIN WHY THE COMPONENT IS CONSIDERED HARMFUL (FOR EXAMPLE, CAUSES ALLERGIES, CONTAINS TOXINS, OR IS CONTROVERSIAL IN SCIENTIFIC RESEARCH).
       • BASE YOUR FINDINGS ON VERIFIED SOURCES SUCH AS EWG, INCI, OR SIMILAR AUTHORITATIVE GUIDES.
       3. PRODUCT ASSESSMENT:
       • ASSIGN A SCORE FROM 1 TO 10 BASED ON THE PRESENCE OF HARMFUL INGREDIENTS:
       • 1–3: MORE THAN 50% OF INGREDIENTS ARE HARMFUL OR ARTIFICIAL.
       • 4–6: UP TO 30% OF INGREDIENTS ARE UNDESIRABLE, BUT THE PRODUCT CONTAINS NATURAL OR SAFE COMPONENTS.
       • 7–9: LESS THAN 10% OF INGREDIENTS ARE HARMFUL, AND THE REST ARE NATURAL AND SAFE.
       • 10: THE PRODUCT IS COMPLETELY NATURAL AND FREE OF HARMFUL INGREDIENTS.
       4. RECOMMENDATION FOR A NATURAL ALTERNATIVE:
       • SUGGEST A SAFE, MORE NATURAL ALTERNATIVE AVAILABLE IN THE USER’S REGION.
       • IF NO ALTERNATIVE EXISTS, CLEARLY STATE THIS.
       5. FORMATTING THE RESPONSE:
       • PRODUCT NAME: [Product name]
       • COMPOSITION ANALYSIS: BRIEF DESCRIPTION OF HARMFUL INGREDIENTS AND WHY THEY ARE UNDESIRABLE.
       • ANALOG RECOMMENDATION: NAME OF A PRODUCT THAT OFFERS A NATURAL ALTERNATIVE, OR CLEAR INDICATION THAT NONE EXISTS.
       • FINAL RATING: A SCORE FROM 1 TO 10 BASED ON THE INGREDIENTS.
      
      WHAT NOT TO DO:
      
       • DO NOT PROVIDE LONG LISTS OF INGREDIENTS WITHOUT EXPLANATION.
       • DO NOT IGNORE THE REASONS WHY A COMPONENT IS CONSIDERED HARMFUL.
       • DO NOT FORGET TO PROVIDE A FINAL PRODUCT SCORE FROM 1 TO 10.
       • DO NOT IGNORE THE NEED TO OFFER A NATURAL ALTERNATIVE OR CLEARLY STATE ITS ABSENCE.
       • DO NOT RETURN RESPONSES IN OTHER LANGUAGES BESIDES RUSSIAN, REGARDLESS OF THE INPUT LANGUAGE.
       • AVOID OVERLOADING THE RESPONSE WITH UNNECESSARY DETAILS; KEEP IT CONCISE AND USEFUL.
      
      SAMPLE RESPONSE:
      
      Product: Juicy Sausages “Papa Can”
      Final product rating: 5/10.
      Percentage of non-natural ingredients: 40%.
      Recommendation for an alternative: Look for sausages without phosphates and mechanically deboned meat, such as those from farm producers.
      Composition analysis:
      
       • Mechanically separated meat: less valuable than whole meat.
       • Sodium nitrite: preservative, potentially harmful with regular consumption.
       • Phosphates: may affect calcium balance.
       • Carrageenan: may cause inflammation with regular intake.
      
      Always respond in Russian. here is the text:\n\n${text}` }
    ]
  });
  return response.choices[0].message.content;
};

// Функция для проверки подписки на канал
const checkSubscription = async (chatId) => {
  try {
    const member = await bot.getChatMember(channelUsername, chatId);
    const isMember = ['creator', 'administrator', 'member'].includes(member.status);
    return isMember;
  } catch (err) {
    console.error('Error checking subscription:', err);
    return false;
  }
};

// Функция для обработки подписки
const handleSubscription = async (chatId) => {
  const isSubscribed = await checkSubscription(chatId);

  if (isSubscribed) {
    db.run("INSERT OR IGNORE INTO users (chat_id) VALUES (?)", [chatId]);
    return true;
  } else {
    db.run("INSERT OR IGNORE INTO pending_users (chat_id) VALUES (?)", [chatId]);
    return false;
  }
};

// Функция для проверки подписки при нажатии на кнопку
const handleSubscriptionCheck = async (chatId) => {
  const isSubscribed = await checkSubscription(chatId);
  if (isSubscribed) {
    db.run("DELETE FROM pending_users WHERE chat_id = ?", [chatId]);
    db.run("INSERT OR IGNORE INTO users (chat_id) VALUES (?)", [chatId]);
    bot.sendMessage(chatId, `Благодарим за подписку!

Я, SostavGuru, твой личный помощник в анализе продуктов питания. Я предоставляю точные анализы составов продуктов, чтобы помочь тебе делать осознанный выбор. Все анализы выполняются с помощью мощнейшей модели искусственного интеллекта ChatGPT-4. Просто отправь мне фото состава продукта, и я расскажу тебе все о его качестве и безопасности.
    
Давай начнем и сделаем твой выбор осознанным! 📸😊

[Подробная инструкция по боту здесь ➡️ нажать](https://your-instruction-link)

[Ознакомиться с офертой здесь ➡️ нажать](https://your-offer-link)

Если у вас есть пожелания, просьбы или вы нашли баг, пожалуйста, сообщите нам об этом. Мы будем рады любой обратной связи! 😊 
➡️ [нажать](https://your-feedback-link)`);
  } else {
    bot.sendMessage(chatId, `Привет!

😎 Меня зовут Сергей, я основатель бота SostavGuru, и вместе с командой мы занимаемся его разработкой.

Чтобы использовать бота, необходимо подписаться на наш Telegram-канал [‘На нейронках’](https://t.me/naneironkah), где я рассказываю, как живу с нейросетями и использую их в бизнесе и повседневной жизни.

Подписка обязательна, чтобы вы могли получать БЕСПЛАТНЫЕ анализы составов продуктов. Это поможет нам развивать наш блог и делиться с вами еще больше полезной информацией!🔥`, { parse_mode: 'Markdown' });
  }
};

// Функция для обновления счётчиков каждую неделю
const resetWeeklyCounts = () => {
  const now = new Date();
  const weekStart = new Date(now.setDate(now.getDate() - now.getDay())); // Воскресенье
  weekStart.setHours(0, 0, 0, 0); // Устанавливаем время на 00:00

  db.run("UPDATE users SET photo_count = 10, last_reset = ? WHERE last_reset < ?", [weekStart.toISOString(), weekStart.toISOString()]);
};


// Запланируем обновление счётчиков каждую неделю
schedule.scheduleJob('0 0 * * 0', resetWeeklyCounts); // Срабатывает каждое воскресенье в 00:00

// Обработчик команды /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const args = msg.text.split(' ');
  const referralName = args[1];

  if (referralName) {
    // Проверить, существует ли пользователь с данным telegram_id
    db.get(
      `SELECT * FROM users WHERE chat_id = ?`,
      [msg.from.id],
      (err, row) => {
        if (err) {
          console.error('Ошибка при получении пользователя из базы данных:', err);
          return;
        }

        if (!row) {
          // Найти реферальную ссылку и увеличить количество кликов
          db.get(
            `SELECT * FROM referrals WHERE referral_name = ?`,
            [referralName],
            (err, row) => {
              if (err) {
                console.error('Ошибка при получении реферальной ссылки из базы данных:', err);
              } else if (row) {
                saveUser(msg, row.referrer_id, referralName);
                updateReferralClickCount(referralName);
              } else {
                saveUser(msg);
              }
            }
          );
        } else {
          saveUser(msg);
        }
      }
    );
  } else {
    saveUser(msg);
  }

  if (await handleSubscription(chatId)) {
    if (specialUsers.includes(chatId.toString())) {
      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Таблица', callback_data: 'table' }],
            [{ text: 'Сделать ссылку', callback_data: 'generate_link' }],
            [{ text: 'Посмотреть ссылки', callback_data: 'mishadayn'}]
          ]
        }
      };
      bot.sendMessage(chatId, `Привет! 👋 
      Я, SostavGuru, твой личный помощник в анализе продуктов питания. Я предоставляю точные анализы составов продуктов, чтобы помочь тебе делать осознанный выбор. Все анализы выполняются с помощью мощнейшей модели искусственного интеллекта ChatGPT-4O. Просто отправь мне фото состава продукта, и я расскажу тебе все о его качестве и безопасности.
      Давай начнем и сделаем твой выбор осознанным! 📸😊
      
      Подробная инструкция по боту здесь ➡️ нажать 
      
      Ознакомится с офертой здесь  ➡️ нажать 
      
      Если у вас есть пожелания, просьбы или вы нашли баг, пожалуйста, сообщите нам об этом. Мы будем рады любой обратной связи! 😊 
      ➡️ нажать`, options);
    } else {
      bot.sendMessage(chatId, `Привет! 👋 
      Я, SostavGuru, твой личный помощник в анализе продуктов питания. Я предоставляю точные анализы составов продуктов, чтобы помочь тебе делать осознанный выбор. Все анализы выполняются с помощью мощнейшей модели искусственного интеллекта ChatGPT-4O. Просто отправь мне фото состава продукта, и я расскажу тебе все о его качестве и безопасности.
      Давай начнем и сделаем твой выбор осознанным! 📸😊
      
      Подробная инструкция по боту здесь ➡️ нажать 
      
      Ознакомится с офертой здесь  ➡️ нажать 
      
      Если у вас есть пожелания, просьбы или вы нашли баг, пожалуйста, сообщите нам об этом. Мы будем рады любой обратной связи! 😊 
      ➡️ нажать`);
    }
  } else {
    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Проверить подписку', callback_data: 'check_subscription' }]
        ]
      }
    };
    bot.sendMessage(chatId, `Привет! 
    😎 Меня зовут Сергей, я основатель бота SostavGuru, и вместе с командой мы занимаемся его разработкой.
    Чтобы использовать бота, необходимо подписаться на наш Telegram-канал ‘На нейронках’, где я рассказываю, как живу с нейросетями и использую их в бизнесе и повседневной жизни.
    Подписка обязательна, чтобы вы могли получать БЕСПЛАТНЫЕ анализы составов продуктов. 
    Это поможет нам развивать наш блог и делиться с вами еще больше полезной информацией!🔥 (https://t.me/naneironkah),.`, options);
  }
});

// Обработчик нажатия на inline-кнопки
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === 'check_subscription') {
    await handleSubscriptionCheck(chatId);
  } else if (data === 'table' && specialUsers.includes(chatId.toString())) {
    // Генерация и отправка Excel файла
    generateAndSendExcel(chatId);
  } else if (data === 'mishadayn' && specialUsers.includes(chatId.toString())) {
    generateMisha(chatId)
  }  
   else if (data === 'generate_link' && specialUsers.includes(chatId.toString())) {
    // Запрос названия для ссылки
    bot.sendMessage(chatId, 'Введите название для ссылки:');
    bot.once('message', async (msg) => {

    const referralName = msg.text;
    const referrerId = msg.from.id;

    db.run(
      `INSERT INTO referrals (referrer_id, referral_name) VALUES (?, ?)`,
      [referrerId, referralName],
      (err) => {
        if (err) {
          console.error('Ошибка при создании реферальной ссылки:', err);
          bot.sendMessage(chatId,'Произошла ошибка при создании реферальной ссылки.');
          return;
        }
        bot.sendMessage(chatId,`Реферальная ссылка создана: https://t.me/SostavGuruBot?start=${referralName}`);
      }
    );


      // const linkName = msg.text;
      // const link = `https://t.me/SostavGuruBot?start=${linkName}`;
      
      // db.run("INSERT INTO links (chat_id, link_name, link) VALUES (?, ?, ?)", [chatId, linkName, link], function(err) {
      //   if (err) {
      //     console.error('Database error:', err);
      //     bot.sendMessage(chatId, 'Произошла ошибка при создании ссылки.');
      //   } else {
      //     bot.sendMessage(chatId, `Ссылка успешно создана: ${link}`);
      //   }
      // });
    });
  }
});

// Обработчик команды /balance
bot.onText(/\/balance/, (msg) => {
  const chatId = msg.chat.id;

  db.get("SELECT photo_count FROM users WHERE chat_id = ?", [chatId], (err, row) => {
    if (err) {
      console.error('Database error:', err);
      bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте снова.');
      return;
    }

    if (row) {
      bot.sendMessage(chatId, `У вас использовано ${row.photo_count} из 10 обработок.`);
    } else {
      bot.sendMessage(chatId, 'Вы не тратили запросы, у вас 10 из 10');
    }
  });
});

// Обработчик загрузки фото
// Обработчик получения фотографии
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || '';
  const first_name = msg.from.first_name || '';
  const last_name = msg.from.last_name || '';

  // Проверяем, есть ли пользователь в базе данных users
  db.get("SELECT photo_count, last_reset FROM users WHERE chat_id = ?", [chatId], async (err, row) => {
    if (err) {
      console.error('Database error:', err);
      bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте снова.');
      return;
    }

    const now = new Date();

    if (row) {
      let { photo_count, last_reset } = row;
      const lastResetDate = new Date(last_reset);

      // Проверяем, если прошло больше недели с последнего сброса, сбрасываем счетчик
      if (now - lastResetDate >= 7 * 24 * 60 * 60 * 1000) {
        photo_count = 0;
        last_reset = now.toISOString();
        db.run("UPDATE users SET photo_count = 0, last_reset = ? WHERE chat_id = ?", [last_reset, chatId], (err) => {
          if (err) {
            console.error('Database error:', err);
            bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте снова.');
            return;
          }
        });
      }

      if (photo_count < 10) {
        // Сообщение о получении фото
        bot.sendMessage(chatId, '⏳ Фото получено! Проверяю состав и оцениваю продукт.');

        // Получаем файл
        const photoId = msg.photo[msg.photo.length - 1].file_id;
        bot.getFile(photoId).then((file) => {
          const filePath = file.file_path;
          const url = `https://api.telegram.org/file/bot${token}/${filePath}`;

          // Скачиваем файл
          const fileName = `./${photoId}.jpg`;
          const fileStream = fs.createWriteStream(fileName);
          request(url).pipe(fileStream).on('close', () => {
            // Распознаем текст с изображения
            recognizeText(fileName).then((text) => {
              // Сохраняем распознанный текст в базу данных
              saveRecognizedText(chatId, text);

              // Отправляем распознанный текст на анализ в OpenAI
              analyzeText(text).then((analysis) => {
                bot.sendMessage(chatId, `Анализ продукта:\n${analysis}`);
                fs.unlinkSync(fileName); // Удаляем файл после обработки
              }).catch((err) => {
                bot.sendMessage(chatId, 'Произошла ошибка при анализе текста.');
                console.error(err);
                fs.unlinkSync(fileName); // Удаляем файл после обработки
              });
            }).catch((err) => {
              bot.sendMessage(chatId, 'Произошла ошибка при распознавании текста.');
              console.error(err);
              fs.unlinkSync(fileName); // Удаляем файл после обработки
            });
          });
        }).catch((err) => {
          bot.sendMessage(chatId, 'Не удалось получить файл.');
          console.error(err);
        });

        // Обновляем счетчик отправленных фотографий
        db.run("UPDATE users SET photo_count = photo_count + 1 WHERE chat_id = ?", [chatId], (err) => {
          if (err) {
            console.error('Database error:', err);
            bot.sendMessage(chatId, 'Произошла ошибка при обновлении счетчика фотографий.');
          }
        });
      } else {
        bot.sendMessage(chatId, 'Вы достигли лимита на 10 фотографий в неделю. Попробуйте снова через неделю.');
      }
    } else {
      // Добавляем нового пользователя в базу данных
      const last_reset = now.toISOString();
      db.run("INSERT INTO users (chat_id, username, first_name, last_name, photo_count, last_reset) VALUES (?, ?, ?, ?, ?, ?)",
        [chatId, username, first_name, last_name, 0, last_reset], (err) => {
        if (err) {
          console.error('Database error:', err);
          bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте снова.');
          return;
        }
        const options = {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Проверить подписку', callback_data: 'check_subscription' }]
            ]
          }
        };
        bot.sendMessage(chatId, `Привет!

        😎 Меня зовут Сергей, я основатель бота SostavGuru, и вместе с командой мы занимаемся его разработкой.
        
        Чтобы использовать бота, необходимо подписаться на наш Telegram-канал [‘На нейронках’](https://t.me/naneironkah), где я рассказываю, как живу с нейросетями и использую их в бизнесе и повседневной жизни.
        
        Подписка обязательна, чтобы вы могли получать БЕСПЛАТНЫЕ анализы составов продуктов. Это поможет нам развивать наш блог и делиться с вами еще больше полезной информацией!🔥`, { parse_mode: 'Markdown' });
      });
    }
  });
});




// Обработчик текстовых сообщений
// Обработчик для всех текстовых сообщений, кроме команд
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const messageText = msg.text;

  // Проверяем, что сообщение не является командой и не является ответом на нажатие кнопки
  if (messageText && !messageText.startsWith('/') && !msg.reply_to_message) {
    bot.sendMessage(chatId, `📸 На данный момент, Я могу работать только с фотографиями состава продуктов. Пожалуйста, отправь мне фото, и я сразу начну анализ!`);
  }
});



// Функция для генерации и отправки Excel-файла с данными пользователей
const generateAndSendExcel = async (chatId) => {
  // db.run(
  //   `UPDATE users SET photo_count = photo_count - 1`, (err) => {
      
      
  //     if (err) {
  //       console.error('Ошибка при обновлении количества кликов по реферальной ссылке:', err);
  //     }
  //   }
  // );
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Users');

  worksheet.columns = [
    { header: 'ID', key: 'id', width: 10 },
    { header: 'Chat ID', key: 'chat_id', width: 30 },
    { header: 'Username', key: 'username', width: 30 },
    { header: 'First Name', key: 'first_name', width: 30 },
    { header: 'Last Name', key: 'last_name', width: 30 },
  ];

  db.all("SELECT * FROM users", [], (err, rows) => {
    if (err) {
      throw err;
    }

    rows.forEach((row) => {
      worksheet.addRow({
        id: row.id,
        chat_id: row.chat_id,
        username: row.username,
        first_name: row.first_name,
        last_name: row.last_name,
      });
    });

    workbook.xlsx.writeBuffer().then((buffer) => {
      const filePath = './UsersData.xlsx';
      fs.writeFileSync(filePath, buffer);
      bot.sendDocument(chatId, filePath);
    }).catch((err) => {
      console.error('Error generating Excel file:', err);
      bot.sendMessage(chatId, 'Произошла ошибка при генерации Excel файла.');
    });
  });
};
const generateMisha = async (chatId) => {
db.all('SELECT * FROM referrals', async (err, rows) => {

    // Создание Excel файла
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Referrals');

    // Добавление заголовков
    worksheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Название ссылки', key: 'referral_name', width: 30 },
      { header: 'Сколько перешло', key: 'click_count', width: 15 },
    ];

    // Добавление данных
    rows.forEach((referral) => {
      worksheet.addRow(referral);
    });

    // Сохранение файла

    // await workbook.xlsx.writeFile(filePath);

    workbook.xlsx.writeBuffer().then((buffer) => {
      const filePath = 'referrals.xlsx';
      fs.writeFileSync(filePath, buffer);
      bot.sendDocument(chatId, filePath);
    })
    // Отправка файла пользователю
    // ctx.replyWithDocument({ source: filePath, filename: 'referrals.xlsx' });
  });
}