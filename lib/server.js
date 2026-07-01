import express from 'express';
import dotenv from 'dotenv';
import chalk from 'chalk';

dotenv.config();

const port = process.env.PORT || 8080;
const app = express();
app.use(express.json());

function startServer() {
  app.get('/', (req, res) => {
    res.send('NIT Jalandhar Reddit Bot is running!');
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), freeMemory: process.memoryUsage().heapUsed, memoryLimit: process.memoryUsage().heapTotal, timestamp: new Date() });
  });

  app.listen(port, () => {
    console.log(chalk.green('[SERVER]') + ` Server is running on http://localhost:${port}`);
  });
}

export { startServer };