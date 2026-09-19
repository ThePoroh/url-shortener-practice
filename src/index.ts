import express, { type Request, type Response } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { UAParser } from 'ua-parser-js';
import { PrismaClient } from '@prisma/client';

const app = express();
// Довіра заголовкам проксі Render (x-forwarded-proto, x-forwarded-host)
app.set('trust proxy', 1);

const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 1. Створення скороченого посилання
app.post('/api/links', async (req: Request, res: Response) => {
  try {
    const { originalUrl, customCode, maxClicks } = req.body;

    if (!originalUrl) {
      return res.status(400).json({ error: 'Параметр originalUrl обовʼязковий' });
    }

    const code = String(customCode || crypto.randomBytes(3).toString('hex'));

    const existing = await prisma.link.findUnique({ where: { code } });
    if (existing) {
      return res.status(409).json({ error: 'Такий код уже зайнятий' });
    }

    // Якщо передано валідне додатне число — зберігаємо як ліміт
    const parsedMaxClicks = maxClicks && Number(maxClicks) > 0 ? Number(maxClicks) : null;

    const link = await prisma.link.create({
      data: {
        code,
        originalUrl,
        maxClicks: parsedMaxClicks
      }
    });

    // Підтримка зворотного проксі Render (x-forwarded-host) та локального хоста
    const host = (req.headers['x-forwarded-host'] as string) || req.get('host');
    const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol;
    const baseUrl = `${protocol}://${host}`;

    return res.status(201).json({
      code: link.code,
      shortUrl: `${baseUrl}/go/${link.code}`,
      originalUrl: link.originalUrl,
      maxClicks: link.maxClicks
    });
  } catch (error) {
    return res.status(500).json({ error: 'Помилка створення посилання' });
  }
});

// 2. Редірект зі збором метрик та перевіркою ліміту (без кешування)
app.get('/go/:code', async (req: Request, res: Response) => {
  try {
    const code = String(req.params.code);

    const link = await prisma.link.findUnique({
      where: { code },
      include: { clicks: true }
    });

    if (!link) {
      return res.status(404).send('Посилання не знайдено');
    }

    // Перевірка ліміту кліків (one-time link або задана кількість)
    if (link.maxClicks !== null && link.clicks.length >= link.maxClicks) {
      res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache'
      });
      return res.status(410).send(`
        <!DOCTYPE html>
        <html lang="uk">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Ліміт вичерпано</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
            .box { text-align: center; background: #1e293b; padding: 36px; border-radius: 12px; border: 1px solid #334155; max-width: 420px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
            h1 { color: #ef4444; font-size: 20px; margin-bottom: 10px; }
            p { color: #94a3b8; font-size: 14px; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="box">
            <h1>⛔ Ліміт переходів вичерпано</h1>
            <p>Це одноразове або обмежене посилання досягло встановленого максимуму переходів (${link.maxClicks}).</p>
          </div>
        </body>
        </html>
      `);
    }

    const uaHeader = (req.headers['user-agent'] as string) || '';
    const parser = new UAParser(uaHeader);
    const parsedDevice = parser.getDevice().type || 'desktop';
    const parsedOS = parser.getOS().name || 'Unknown OS';
    const parsedBrowser = parser.getBrowser().name || 'Unknown Browser';

    await prisma.click.create({
      data: {
        linkId: link.id,
        userAgent: uaHeader,
        device: parsedDevice,
        os: parsedOS,
        browser: parsedBrowser
      }
    });

    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    return res.redirect(302, link.originalUrl);
  } catch (error) {
    return res.status(500).send('Помилка сервера під час редіректу');
  }
});

// 3. Розширена аналітика (без кешування)
app.get('/api/links/:code/stats', async (req: Request, res: Response) => {
  try {
    const code = String(req.params.code);

    const link: any = await prisma.link.findUnique({
      where: { code },
      include: {
        clicks: {
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!link) {
      return res.status(404).json({ error: 'Посилання не знайдено' });
    }

    const totalClicks = link.clicks.length;

    // Агрегація даних для графіків і статистики
    const devices: Record<string, number> = {};
    const browsers: Record<string, number> = {};
    const osList: Record<string, number> = {};
    const timeline: Record<string, number> = {};

    link.clicks.forEach((c: any) => {
      const dev = c.device || 'desktop';
      devices[dev] = (devices[dev] || 0) + 1;

      const br = c.browser || 'Unknown';
      browsers[br] = (browsers[br] || 0) + 1;

      const os = c.os || 'Unknown';
      osList[os] = (osList[os] || 0) + 1;

      const d = new Date(c.createdAt);
      const timeKey = `${String(d.getHours()).padStart(2, '0')}:00`;
      timeline[timeKey] = (timeline[timeKey] || 0) + 1;
    });

    // Визначення лідерів
    const topDevice = Object.entries(devices).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
    const topBrowser = Object.entries(browsers).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';

    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    });

    return res.json({
      code: link.code,
      originalUrl: link.originalUrl,
      createdAt: link.createdAt,
      maxClicks: link.maxClicks,
      totalClicks,
      topDevice,
      topBrowser,
      devices,
      browsers,
      osList,
      timeline,
      recentClicks: link.clicks.slice(0, 15)
    });
  } catch (error) {
    return res.status(500).json({ error: 'Помилка отримання статистики' });
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер успішно запущено на порту ${PORT}`);
});