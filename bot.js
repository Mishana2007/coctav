const TelegramBot = require('node-telegram-bot-api');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const request = require('request');
// const { OpenAI } = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const {GoogleAIFileManager,FileState,GoogleAICacheManager,} = require("@google/generative-ai/server");
const schedule = require('node-schedule'); // Для планирования обновлений счётчиков
const ExcelJS = require('exceljs'); // Для работы с Excel
const sqlite3 = require('sqlite3').verbose(); 
const axios = require('axios');
require('dotenv').config();

const token = process.env.TOKEN;
const genAI = new GoogleGenerativeAI(process.env.GENAI1);
const fileManager = new GoogleAIFileManager(process.env.GENAI1);
const channelUsername = process.env.CHANNEL_USERNAME;

const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Укажите ID пользователей, которым будут доступны кнопки "Таблица" и "Создать ссылку"
const specialUsers = ['1301142907', '1292205718', '22566'];

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
    photo_count INTEGER DEFAULT 10,
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
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS used_referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      referral_name TEXT,
      used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, referral_name)
    )`);
  });

  // Добавляем столбец last_reset, если он не существует
  db.run("ALTER TABLE users ADD COLUMN last_reset TIMESTAMP DEFAULT CURRENT_TIMESTAMP", (err) => {
    if (err && err.code !== 'SQLITE_ERROR') {
      console.error('Error adding column last_reset:', err);
    }
  });
});

// Обновляем функцию saveUser для новых пользователей
const saveUser = async (msg, referrerId = null, referralName = null) => {
  const { id, username, first_name, last_name } = msg.from;

  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM users WHERE chat_id = ?`,
      [id],
      async (err, existingUser) => {
        if (err) {
          console.error('Error checking existing user:', err);
          reject(err);
          return;
        }

        if (!existingUser) {
          // Новый пользователь получает 10 запросов
          db.run(
            `INSERT INTO users (chat_id, username, first_name, last_name, photo_count) 
             VALUES (?, ?, ?, ?, 10)`,
            [id, username, first_name, last_name],
            async (err) => {
              if (err) {
                console.error('Error saving user:', err);
                reject(err);
                return;
              }

              if (referralName) {
                try {
                  const referrerId = await checkAndRewardReferrer(referralName, id);
                  if (referrerId) {
                    bot.sendMessage(
                      referrerId,
                      'Поздравляем! По вашей реферальной ссылке зарегистрировался новый пользователь. Вам начислено 5 дополнительных запросов!'
                    );
                  }
                } catch (error) {
                  console.error('Error handling referral reward:', error);
                }
              }
              resolve();
            }
          );
        } else {
          resolve();
        }
      }
    );
  });
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

const saveRecognizedText = (chatId, text) => {
  db.run("INSERT INTO recognized_texts (chat_id, text) VALUES (?, ?)", [chatId, text]);
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

// Обновляем функцию checkAndRewardReferrer
const checkAndRewardReferrer = (referralName, newUserId) => {
  return new Promise((resolve, reject) => {
    // Сначала проверяем, не использовал ли этот пользователь уже данный реферальный код
    db.get(
      `SELECT * FROM used_referrals WHERE user_id = ? AND referral_name = ?`,
      [newUserId, referralName],
      (err, existingUse) => {
        if (err) {
          console.error('Error checking used referrals:', err);
          reject(err);
          return;
        }

        if (existingUse) {
          resolve(null); // Пользователь уже использовал этот реферальный код
          return;
        }

        // Проверяем, существует ли реферальная ссылка
        db.get(
          `SELECT referrer_id FROM referrals WHERE referral_name = ?`,
          [referralName],
          (err, row) => {
            if (err) {
              console.error('Error checking referrer:', err);
              reject(err);
              return;
            }

            if (!row) {
              resolve(null);
              return;
            }

            // Проверяем, не является ли реферер тем же пользователем
            if (row.referrer_id.toString() === newUserId.toString()) {
              resolve(null);
              return;
            }

            // Записываем использование реферального кода
            db.run(
              `INSERT INTO used_referrals (user_id, referral_name) VALUES (?, ?)`,
              [newUserId, referralName],
              (err) => {
                if (err) {
                  console.error('Error recording referral use:', err);
                  reject(err);
                  return;
                }

                // Добавляем 5 запросов к photo_count реферера
                db.run(
                  `UPDATE users SET photo_count = photo_count + 5 WHERE chat_id = ?`,
                  [row.referrer_id],
                  (err) => {
                    if (err) {
                      console.error('Error updating photo count:', err);
                      reject(err);
                    } else {
                      resolve(row.referrer_id);
                    }
                  }
                );
              }
            );
          }
        );
      }
    );
  });
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

// Функция для ежедневного обновления запросов
const resetDailyCounts = () => {
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);

  // Обновляем количество запросов до 3, только если их меньше 3
  db.run(`
    UPDATE users 
    SET photo_count = CASE 
      WHEN photo_count < 3 THEN 3 
      ELSE photo_count 
    END,
    last_reset = ? 
    WHERE last_reset < ?`,
    [dayStart.toISOString(), dayStart.toISOString()]
  );
};

// Запланируем обновление счётчиков каждую неделю
schedule.scheduleJob('0 0 * * *', resetDailyCounts); // Каждый день в 00:00

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

bot.onText(/\/ref/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Generate a unique referral name using timestamp and user ID
  const referralName = `ref_${userId}`;

  db.run(
    `INSERT INTO referrals (referrer_id, referral_name) VALUES (?, ?)`,
    [userId, referralName],
    (err) => {
      if (err) {
        console.error('Error creating referral link:', err);
        bot.sendMessage(chatId, 'Произошла ошибка при создании реферальной ссылки.');
        return;
      }

      const referralLink = `https://t.me/SostavGuruBot?start=${referralName}`;
      bot.sendMessage(
        chatId,
        `Ваша реферальная ссылка создана!\n\nКогда новый пользователь перейдет по ней, вы получите 5 запросов на обработку фото (если у вас меньше 5 запросов).\n\nВаша ссылка:\n${referralLink}`
      );
    }
  );
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
    });
  }
});

// Обновляем команду /balance
bot.onText(/\/balance/, (msg) => {
  const chatId = msg.chat.id;

  db.get(
    "SELECT photo_count FROM users WHERE chat_id = ?",
    [chatId],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте снова.');
        return;
      }

      if (row) {
        const message = `📊 У вас доступно запросов: ${row.photo_count}\n\n` +
                       `Каждый день в 00:00 количество запросов обновляется до 3, если их осталось меньше.\n` +
                       `Дополнительные запросы можно получить, приглашая друзей! Через команду /ref`;
        bot.sendMessage(chatId, message);
      } else {
        bot.sendMessage(chatId, 'У вас доступно 10 начальных запросов.');
      }
    }
  );
});

// Обновляем обработчик фотографий
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  
  db.get(
    "SELECT photo_count, last_reset FROM users WHERE chat_id = ?",
    [chatId],
    async (err, row) => {
      if (err) {
        console.error('Database error:', err);
        bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте снова.');
        return;
      }

      const now = new Date();

      if (row) {
        let { photo_count, last_reset } = row;
        const lastResetDate = new Date(last_reset);

        // Проверяем, прошел ли день с последнего сброса
        if (now - lastResetDate >= 24 * 60 * 60 * 1000 && photo_count < 3) {
          photo_count = 3;
          last_reset = now.toISOString();
          db.run(
            "UPDATE users SET photo_count = 3, last_reset = ? WHERE chat_id = ?",
            [last_reset, chatId]
          );
        }

        if (photo_count > 0) {
          bot.sendMessage(chatId, '⏳ Фото получено! Проверяю состав и оцениваю продукт.');

          try {
            // Получаем файл с наибольшим размером (последний в массиве photo)
          const photoId = msg.photo[msg.photo.length - 1].file_id;
  
          // Получаем URL для скачивания фотографии
          const file = await bot.getFile(photoId);
          const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  
          // Скачиваем файл на сервер
          const photoResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
          const filePath = `/tmp/${photoId}.jpg`; // Путь для временного сохранения файла
          const fs = require('fs');
          fs.writeFileSync(filePath, photoResponse.data);
  
          // Загружаем файл в Gemini
          const uploadResult = await fileManager.uploadFile(filePath, { mimeType: "image/jpeg" });
  
          // Подготовка файла для запроса
          const photoPart = {
              fileData: {
                  fileUri: uploadResult.file.uri,
                  mimeType: uploadResult.file.mimeType,
              },
          };
  
          // Формируем промпт для анализа
          const prompt = `PROMPT FOR PRODUCT COMPOSITION ANALYSIS, QUALITY ASSESSMENT, AND RECOMMENDATIONS FOR NATURAL ANALOGS

          #### AGENT ROLE:
          YOU ARE THE WORLD'S LEADING EXPERT IN PRODUCT COMPOSITION ANALYSIS, RANKED AS A TOP SPECIALIST IN IDENTIFYING HARMFUL INGREDIENTS AND RECOMMENDING SAFE NATURAL ALTERNATIVES. YOUR PRIMARY TASK IS TO CHECK PRODUCT COMPOSITIONS IN ANY LANGUAGE, IDENTIFY UNDESIRABLE INGREDIENTS, AND PROVIDE QUALITY ASSESSMENTS AND RECOMMENDATIONS FOR NATURAL ALTERNATIVES AVAILABLE IN THE USER'S REGION.
          
          #### GOAL:
          - ANALYZE THE SPECIFIED PRODUCT COMPOSITION AND ASSESS QUALITY BASED ON THE PRESENCE OF HARMFUL OR UNDESIRABLE INGREDIENTS.
          - SUGGEST A NATURAL ALTERNATIVE IF AVAILABLE OR INDICATE THAT NO SUCH ANALOG EXISTS.
          - THE RESPONSE MUST ALWAYS BE IN RUSSIAN, EVEN IF THE INGREDIENT LIST IS PROVIDED IN ANOTHER LANGUAGE.
          
          #### CHAIN OF THOUGHTS:
          
          1. PRODUCT COMPOSITION ANALYSIS:
             - IDENTIFY THE MAIN INGREDIENTS OF THE PRODUCT, REGARDLESS OF THE LANGUAGE IN WHICH THEY ARE LISTED.
             - CHECK EACH INGREDIENT AGAINST RECOMMENDED DATABASES SUCH AS INCI, EWG, COSDNA, AND FDA FOR HARMFUL, ALLERGENIC, OR CONTROVERSIAL SUBSTANCES.
             - FOCUS ON KEY INGREDIENTS THAT MAY HAVE NEGATIVE IMPACTS ON HEALTH OR THE ENVIRONMENT, ESPECIALLY THOSE CONSIDERED AGGRESSIVE, ARTIFICIAL, OR POTENTIALLY TOXIC.
          
          2. DESCRIPTION OF UNDESIRABLE INGREDIENTS:
             - BRIEFLY EXPLAIN WHY THE INGREDIENT IS CONSIDERED HARMFUL (FOR EXAMPLE, CAUSES ALLERGIES, CONTAINS TOXINS, OR IS CONTROVERSIAL IN SCIENTIFIC STUDIES).
             - BASE YOUR ASSESSMENT ON RELIABLE SOURCES, SUCH AS EWG, INCI, OR SIMILAR AUTHORITATIVE GUIDES.
          
          3. PRODUCT ASSESSMENT:
             - ASSIGN A SCORE FROM 1 TO 10 BASED ON THE PRESENCE OF HARMFUL INGREDIENTS:
               - 1–3: MORE THAN 50% OF THE INGREDIENTS ARE HARMFUL OR ARTIFICIAL.
               - 4–6: UP TO 30% OF THE INGREDIENTS ARE CONSIDERED UNDESIRABLE, BUT THE PRODUCT CONTAINS NATURAL OR SAFE COMPONENTS.
               - 7–9: LESS THAN 10% OF THE INGREDIENTS ARE HARMFUL, AND THE REST ARE NATURAL AND SAFE.
               - 10: THE PRODUCT IS FULLY NATURAL, WITH NO HARMFUL INGREDIENTS.
          
          4. NATURAL ANALOG RECOMMENDATION:
             - SUGGEST A SAFE, MORE NATURAL ANALOG AVAILABLE IN THE USER'S MARKET.
             - IF NO ANALOG IS AVAILABLE, CLEARLY INDICATE THIS.
          
          5. ANSWER STRUCTURE:
             - PRODUCT NAME: [Product name]- COMPOSITION ANALYSIS: BRIEF DESCRIPTION OF HARMFUL INGREDIENTS AND WHY THEY ARE UNDESIRABLE.
             - ANALOG RECOMMENDATION: PRODUCT NAME THAT OFFERS A NATURAL ANALOG OR INDICATION THAT NO ANALOG EXISTS.
             - FINAL SCORE: SCORE FROM 1 TO 10 BASED ON INGREDIENTS.
          
          #### WHAT NOT TO DO:
          - DO NOT PROVIDE LONG LISTS OF INGREDIENTS WITHOUT EXPLANATION.
          - DO NOT IGNORE THE REASONS WHY AN INGREDIENT IS CONSIDERED HARMFUL.
          - DO NOT FORGET TO GIVE A FINAL PRODUCT SCORE FROM 1 TO 10.
          - DO NOT NEGLECT THE NEED TO SUGGEST A NATURAL ANALOG OR CLEARLY STATE ITS ABSENCE.
          - DO NOT RETURN ANSWERS IN ANY LANGUAGE OTHER THAN RUSSIAN, REGARDLESS OF THE LANGUAGE OF THE INPUT DATA.
          - AVOID OVERLOADING THE ANSWER WITH UNNECESSARY DETAILS; KEEP IT CONCISE AND USEFUL.
          
          #### SAMPLE RESPONSE:
          Product: Juicy sausages "Papa Can"
          Final product score: 5/10.
          Percentage of non-natural ingredients: 40%.  
          Analog recommendation: Look for sausages without phosphates and mechanically separated meat, such as those from farm producers.  
          Composition analysis:  
          - Mechanically separated meat: Less valuable than whole meat.  
          - Sodium nitrite: Preservative, potentially harmful with regular consumption.  
          - Phosphates: May affect calcium balance.  
          - Carrageenan: Possibly causes inflammation with regular use.
          Always respond in Russian. here is the photo:
          `;
  
          // Отправляем запрос в модель
          const generateResult = await model.generateContent([prompt, photoPart]);
          const response = await generateResult.response;
          const responseText = await response.text();
  
          // Отправляем результат пользователю
          if (!responseText || responseText.toLowerCase().includes("не могу анализировать")) {
              throw new Error('Модель отказалась анализировать фото');
          }
  
          await bot.sendMessage(chatId, `${responseText}`);

            // После успешной обработки уменьшаем счетчик
            db.run(
              "UPDATE users SET photo_count = photo_count - 1 WHERE chat_id = ?",
              [chatId]
            );

          } catch (error) {
            console.error('Ошибка при анализе фотографии:', error);
            bot.sendMessage(
              chatId,
              'Произошла ошибка при анализе фотографии. Пожалуйста, попробуйте еще раз.'
            );
          }
        } else {
          bot.sendMessage(
            chatId,
            'У вас закончились доступные запросы. Дождитесь ежедневного обновления или пригласите друзей по реферальной ссылке для получения дополнительных запросов.'
          );
        }
      }
    }
  );
});

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
    workbook.xlsx.writeBuffer().then((buffer) => {
      const filePath = 'referrals.xlsx';
      fs.writeFileSync(filePath, buffer);
      bot.sendDocument(chatId, filePath);
    })
  });
}
