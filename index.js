import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { customAlphabet } from 'nanoid';

// --- Конфигурация ---
const bot = new Bot(process.env.BOT_TOKEN);
const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 9);
const ALLOW = new Set((process.env.ALLOWED_IDS || '').split(',').map(s => s.trim()).filter(Boolean));

// --- База данных ---
const dbp = open({ filename: './bot.db', driver: sqlite3.Database });

async function initDB() {
  const db = await dbp;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS posts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      owner_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'published'
      media_type TEXT,
      file_id TEXT,
      caption TEXT,
      buttons TEXT, -- JSON: 2D Array [[{...}, {...}], [{...}]]
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_owner_status ON posts (owner_id, status);
  `);
}

// --- Утилиты и работа с БД ---
const guard = (ctx) => {
  const id = ctx.from?.id;
  if (!id || !ALLOW.has(String(id))) {
    ctx.reply('Доступ запрещён.');
    return false;
  }
  return true;
};
const getUserDraft = (userId) => dbp.then(db => db.get("SELECT * FROM posts WHERE owner_id = ? AND status = 'draft'", userId));
const createOrResetDraft = async (userId) => {
  const db = await dbp;
  await db.run("DELETE FROM posts WHERE owner_id = ? AND status = 'draft'", userId);
  await db.run("INSERT INTO posts (owner_id, status, media_type, caption, buttons) VALUES (?, 'draft', 'text', '', '[]')", userId);
  return getUserDraft(userId);
};
const updateDraft = async (userId, data) => {
  const db = await dbp;
  const fields = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const values = Object.values(data);
  await db.run(`UPDATE posts SET ${fields} WHERE owner_id = ? AND status = 'draft'`, [...values, userId]);
};
const publishDraft = async (userId) => {
    const db = await dbp;
    const draft = await getUserDraft(userId);
    if (!draft) return null;
    if (draft.code) { // Редактирование
        await db.run("UPDATE posts SET media_type=?, file_id=?, caption=?, buttons=?, status='published' WHERE code=?", draft.media_type, draft.file_id, draft.caption, draft.buttons, draft.code);
        await db.run("DELETE FROM posts WHERE id = ?", draft.id);
        return draft.code;
    }
    const code = nanoid(); // Новый пост
    await db.run("UPDATE posts SET code=?, status='published' WHERE id=?", code, draft.id);
    return code;
};

/** Парсер "формулы" кнопок */
function parseButtonFormula(formula) {
    const grid = [];
    const lines = formula.trim().split('\n');

    for (const line of lines) {
        if (!line.trim()) continue;
        const row = [];
        const buttonDefs = line.split('|');

        for (const def of buttonDefs) {
            const match = def.trim().match(/^\[(.*?)\]\((.*?)\)$/);
            if (!match) return null; // Ошибка синтаксиса

            const text = match[1];
            const data = match[2];
            const id = nanoid(5);

            if (data.toLowerCase() === 'share') {
                row.push({ type: 'share', text, id });
            } else if (data.startsWith('alert:')) {
                const alertText = data.substring(6);
                row.push({ type: 'alert', text, alert: alertText, id });
            } else if (/^(https?|tg):\/\//.test(data)) {
                row.push({ type: 'url', text, url: data, id });
            } else {
                return null; // Неизвестный тип данных
            }
        }
        grid.push(row);
    }
    return grid;
}

/** Сборка клавиатуры для публикации */
function kbFrom(post) {
    const kb = new InlineKeyboard();
    const rows = JSON.parse(post.buttons || '[]');
    rows.forEach(row => {
        row.forEach(b => {
            if (b.type === 'url') kb.url(b.text, b.url);
            if (b.type === 'alert') kb.text(b.text, `a:${post.code}:${b.id}`);
            if (b.type === 'share') kb.switchInline(b.text, `${post.code}`);
        });
        if (row.length > 0) kb.row();
    });
    return kb;
}

// --- Команды ---
// ИЗМЕНЕНИЕ 1: Добавлен parse_mode для форматирования текста справки
bot.command('start', ctx => ctx.reply(
`Привет!

*Сценарий работы:*
1. Отправь /new для начала.
2. Пришли текст или фото для поста.
3. Следующим сообщением пришли 'формулу' для кнопок.

*Формула кнопок:*
- Каждая строка -> новый ряд кнопок.
- Кнопки в ряду разделяются символом |
- Формат кнопки: [Текст](данные)

*Примеры данных:*
- URL: \`[Google](https://google.com)\`
- Alert: \`[Помощь](alert:Это подсказка)\`
- Share: \`[Поделиться](share)\`

*Другие команды:*
/preview, /save, /edit \`<code>\`, /list, /delete \`<code>\`

---
*Ограничения:*
- *Длина текста:* Текст поста и формула кнопок ограничены лимитом Telegram в 4096 символов на сообщение.
- *Подпись к фото:* Не более 1024 символов.
- *Количество кнопок:* Не более 100 на один пост.
- *Alert-сообщения:* Текст для всплывашки рекомендуется делать до 180 символов.
- *Фото:* Посты с фото хранят только ID файла. Теоретически, он может устареть, но это маловероятно.`,
{ parse_mode: 'Markdown' }
));

bot.command('new', async ctx => { if (guard(ctx)) { await createOrResetDraft(ctx.from.id); await ctx.reply('Черновик сброшен. Пришлите текст или фото.'); } });
bot.command('preview', async (ctx) => {
    if (!guard(ctx)) return;
    const draft = await getUserDraft(ctx.from.id);
    if (!draft) return ctx.reply('Нет черновика. Начните с /new');
    const kb = kbFrom({ ...draft, code: 'PREVIEW' });
    if (draft.media_type === 'photo' && draft.file_id) {
        await ctx.replyWithPhoto(draft.file_id, { caption: draft.caption || '', reply_markup: kb, parse_mode: 'MarkdownV2' });
    } else {
        await ctx.reply(draft.caption || '(пустой текст)', { reply_markup: kb, parse_mode: 'MarkdownV2' });
    }
});

// ИЗМЕНЕНИЕ 2: Команда /save теперь сначала присылает готовый пост, потом код
bot.command('save', async (ctx) => {
    if (!guard(ctx)) return;
    const draft = await getUserDraft(ctx.from.id);
    if (!draft) return ctx.reply('Нет черновика для сохранения.');
    if (!draft.caption && !draft.file_id) return ctx.reply('Нельзя сохранить пустой пост. Добавьте текст или фото.');
    
    const code = await publishDraft(ctx.from.id);
    if (!code) return ctx.reply('Ошибка сохранения.');

    // Получаем финальную версию поста из базы
    const db = await dbp;
    const finalPost = await db.get("SELECT * FROM posts WHERE code = ?", code);

    if (finalPost) {
        const kb = kbFrom(finalPost);
        // Отправляем предпросмотр готового поста
        if (finalPost.media_type === 'photo' && finalPost.file_id) {
            await ctx.replyWithPhoto(finalPost.file_id, {
                caption: finalPost.caption || '',
                reply_markup: kb,
                parse_mode: 'MarkdownV2'
            });
        } else {
            await ctx.reply(finalPost.caption || '(пустой текст)', {
                reply_markup: kb,
                parse_mode: 'MarkdownV2'
            });
        }
    }

    // Отдельным сообщением присылаем код
    const me = await bot.api.getMe();
    await ctx.reply(
        `Пост сохранён. Код для вставки:\n\n\`@${me.username} ${code}\``,
        { parse_mode: 'Markdown' }
    );
});

bot.command('edit', async (ctx) => {
    if (!guard(ctx)) return;
    const code = ctx.match.trim().toUpperCase();
    if (!code) return ctx.reply('Укажите код поста: /edit КОД');
    const db = await dbp;
    const post = await db.get("SELECT * FROM posts WHERE code = ? AND status = 'published'", code);
    if (!post) return ctx.reply('Пост не найден.');
    if (post.owner_id !== ctx.from.id) return ctx.reply('Это не ваш пост.');
    await db.run("DELETE FROM posts WHERE owner_id = ? AND status = 'draft'", ctx.from.id);
    await db.run(`INSERT INTO posts (code, owner_id, status, media_type, file_id, caption, buttons) VALUES (?, ?, 'draft', ?, ?, ?, ?)`, post.code, post.owner_id, post.media_type, post.file_id, post.caption, post.buttons);
    await ctx.reply(`Пост ${code} загружен в черновик. Можете отправить новый текст/фото или новую формулу кнопок, затем /save.`);
});
bot.command('list', async (ctx) => {
    if (!guard(ctx)) return;
    const db = await dbp;
    const posts = await db.all("SELECT code, caption FROM posts WHERE owner_id = ? AND status = 'published' ORDER BY created_at DESC", ctx.from.id);
    if (posts.length === 0) return ctx.reply('У вас нет постов.');
    const list = posts.map(p => `▫️ ${p.code} - ${(p.caption || 'Фото').slice(0, 40)}...`).join('\n');
    await ctx.reply(`Ваши посты:\n\n${list}`);
});
bot.command('delete', async (ctx) => {
    if (!guard(ctx)) return;
    const code = ctx.match.trim().toUpperCase();
    if (!code) return ctx.reply('Укажите код поста: /delete КОД');
    const db = await dbp;
    const res = await db.run("DELETE FROM posts WHERE code = ? AND owner_id = ?", code, ctx.from.id);
    if (res.changes > 0) {
        await ctx.reply(`Пост ${code} удалён.`);
    } else {
        await ctx.reply('Пост не найден или это не ваш пост.');
    }
});


// --- Обработчики сообщений ---
bot.on('message:text', async (ctx, next) => {
    if (ctx.msg.text.startsWith('/')) return next();
    if (!guard(ctx)) return;
    const userId = ctx.from.id;
    const draft = await getUserDraft(userId);
    if (!draft) return;

    if (!draft.caption && !draft.file_id) {
        await updateDraft(userId, { media_type: 'text', file_id: null, caption: ctx.msg.text });
        await ctx.reply('Текст принят. Теперь пришлите формулу кнопок.');
        return;
    }

    const buttonsGrid = parseButtonFormula(ctx.msg.text);
    if (buttonsGrid) {
        await updateDraft(userId, { buttons: JSON.stringify(buttonsGrid) });
        await ctx.reply(`Кнопки установлены. Проверьте через /preview и сохраняйте через /save.`);
    } else {
        await ctx.reply('Ошибка в синтаксисе формулы. Проверьте формат и попробуйте снова.');
    }
});
bot.on('message:photo', async (ctx) => {
    if (!guard(ctx)) return;
    const userId = ctx.from.id;
    const draft = await getUserDraft(userId);
    if (!draft) return;
    const fileId = ctx.msg.photo.at(-1)?.file_id;
    await updateDraft(userId, { media_type: 'photo', file_id: fileId, caption: ctx.msg.caption || '' });
    await ctx.reply('Фото принято. Теперь пришлите формулу кнопок.');
});


// --- Обработчик Alert-кнопок и Инлайн ---
bot.on('callback_query:data', async (ctx) => {
    if (!guard(ctx)) return ctx.answerCallbackQuery();
    const data = ctx.callbackQuery.data;
    if (!data?.startsWith('a:')) return ctx.answerCallbackQuery();
    const [, code, btnId] = data.split(':');
    if (code === 'PREVIEW') return ctx.answerCallbackQuery({ text: 'Это превью, кнопки неактивны.', show_alert: true });
    const post = await dbp.then(db => db.get("SELECT buttons FROM posts WHERE code = ?", code));
    if (post) {
        const btn = JSON.parse(post.buttons).flat().find(b => b.id === btnId);
        if (btn) await ctx.answerCallbackQuery({ text: btn.alert || '...', show_alert: true });
    }
});
bot.on('inline_query', async (ctx) => {
    const uid = ctx.inlineQuery.from?.id;
    if (!ALLOW.has(String(uid))) return ctx.answerInlineQuery([], { cache_time: 3600 });
    const code = ctx.inlineQuery.query.trim().toUpperCase();
    if (!code) return ctx.answerInlineQuery([], { cache_time: 10 });
    const db = await dbp;
    const post = await db.get("SELECT * FROM posts WHERE code = ? AND status = 'published'", code);
    if (!post) return ctx.answerInlineQuery([], { cache_time: 10 });
    const kb = kbFrom(post);
    if (post.media_type === 'photo' && post.file_id) {
        await ctx.answerInlineQuery([{ type: 'photo', id: post.code, photo_file_id: post.file_id, caption: post.caption || '', reply_markup: kb, parse_mode: 'MarkdownV2' }], { cache_time: 5 });
    } else {
        await ctx.answerInlineQuery([{ type: 'article', id: post.code, title: `Вставить пост`, input_message_content: { message_text: post.caption || '', parse_mode: 'MarkdownV2' }, reply_markup: kb, description: (post.caption || '').slice(0, 50) }], { cache_time: 5 });
    }
});


// --- Запуск ---
bot.catch((err) => console.error(err));
async function startApp() {
    await initDB();
    await bot.start();
    console.log('Bot started (long polling)');
}
startApp();