import express, { type Request, type Response } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { UAParser } from 'ua-parser-js';
import { PrismaClient } from '@prisma/client';

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 1. Створення скороченого посилання
app.post('/api/links', async (req: Request, res: Response) => {
  try {
    const { originalUrl, customCode } = req.body;

    if (!originalUrl) {
      return res.status(400).json({ error: 'Параметр originalUrl обовʼязковий' });
    }

    const code = String(customCode || crypto.randomBytes(3).toString('hex'));

    const existing = await prisma.link.findUnique({ where: { code } });
    if (existing) {
      return res.status(409).json({ error: 'Такий код уже зайнятий' });
    }

    const link = await prisma.link.create({
      data: { code, originalUrl }
    });

    return res.status(201).json({
      code: link.code,
      shortUrl: `http://localhost:${PORT}/go/${link.code}`,
      originalUrl: link.originalUrl
    });
  } catch (error) {
    return res.status(500).json({ error: 'Помилка створення посилання' });
  }
});

// 2. Редірект зі збором метрик (без кешування)
app.get('/go/:code', async (req: Request, res: Response) => {
  try {
    const code = String(req.params.code);

    const link = await prisma.link.findUnique({ where: { code } });
    if (!link) {
      return res.status(404).send('Посилання не знайдено');
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

// 3. Аналітика (без кешування)
app.get('/api/links/:code/stats', async (req: Request, res: Response) => {
  try {
    const code = String(req.params.code);

    const link: any = await prisma.link.findUnique({
      where: { code },
      include: { clicks: true }
    });

    if (!link) {
      return res.status(404).json({ error: 'Посилання не знайдено' });
    }

    const totalClicks = link.clicks.length;

    const devices = link.clicks.reduce((acc: Record<string, number>, click: any) => {
      const dev = click.device || 'desktop';
      acc[dev] = (acc[dev] || 0) + 1;
      return acc;
    }, {});

    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    });

    return res.json({
      code: link.code,
      originalUrl: link.originalUrl,
      totalClicks,
      devices,
      recentClicks: link.clicks.slice(-10).reverse()
    });
  } catch (error) {
    return res.status(500).json({ error: 'Помилка отримання статистики' });
  }
});

// Обов'язковий рядок запуску сервера:
app.listen(PORT, () => {
  console.log(`🚀 Сервер успішно запущено: http://localhost:${PORT}`);
});