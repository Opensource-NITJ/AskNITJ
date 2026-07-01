import { generateDmResponse } from '../handlers/dmResponseGenerator.js';
import { replyDM, getUserOverview } from '../lib/redditClient.js';
import { addDM, getDMHistory } from '../lib/database.js';
import chalk from 'chalk';

async function newDMProcessor(messages) {
  for (const message of messages) {
    try {
      console.log(chalk.magenta('[DM]') + ` Processing DM ${message.id} from ${message.sender}: ${message.body.slice(0, 100)}...`);

      const chatHistory = await getDMHistory(message.sender, 20);

      let response = await generateDmResponse(
        message,
        null,
        `This message is from u/${message.sender}`,
        chatHistory
      );

      while (response.action === 'query_user') {
        const username = response.text;
        console.log(chalk.magenta('[DM]') + ` Querying user ${username} for DM ${message.id}`);
        const userData = await getUserOverview(username);
        const userContext = userData
          .map((item) => `${item.kind === 't3' ? 'Post' : 'Comment'} in r/${item.subreddit}: ${item.content}`)
          .join('\n');
        
        response = await generateDmResponse(
          message,
          { username, data: userContext },
          '',
          chatHistory
        );
      }

      if (response.action === 'reply' && response.text && response.text.trim()) {
        const replyResult = await replyDM(message.id, response.text);
        console.log(chalk.magenta('[DM]') + ` Sent DM response to ${message.sender}: ${response.text.slice(0, 100)}...`);

        try {
          const replyData = replyResult?.json?.data?.things?.[0]?.data;
          const botMsgId = replyData?.id || `bot_reply_${Date.now()}`;
          const botMsgTime = replyData?.created_utc || Math.floor(Date.now() / 1000);
          await addDM({
            id: botMsgId,
            sender: process.env.REDDIT_USERNAME || 'AskNITJ',
            recipient: message.sender,
            body: response.text,
            created_utc: botMsgTime,
          });
        } catch (dbErr) {
          console.error(chalk.red('[ERROR]') + ` Error saving bot DM reply to database:`, dbErr.message);
        }
      } else {
        console.log(chalk.magenta('[DM]') + ` Skipping DM ${message.id}: action is ${response.action}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(chalk.red('[ERROR]') + ` Error processing DM ${message.id}:`, error.message);
    }
  }
}

export { newDMProcessor };