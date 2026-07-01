import { getRelevantContextFromPgvector } from './embedding.js';
import {
  openai,
  responseSchema,
  searchGiphy,
  selectBestGif,
} from './aiHelpers.js';
import fs from 'fs';
import pkg from 'jsonschema';
import chalk from 'chalk';

const { Validator } = pkg;

async function generateDmResponse(
  message,
  userOverview = null,
  instructions = '',
  chatHistory = [],
) {
  const systemInstruction = fs.readFileSync(
    './assets/systemInstruction.txt',
    'utf-8',
  );
  const messageBody = message.body || '';

  let context = await getRelevantContextFromPgvector(messageBody, true);
  if (context === 'No context available') {
    context =
      'No specific past comments found. Answer using general college knowledge and wiki context.';
  }

  const primaryModel = process.env.GENERATION_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b';
  const fallbackModel = process.env.FALLBACK_GENERATION_MODEL || 'meta/llama-3.1-70b-instruct';
  let retries = 3;
  let content = null;

  while (retries > 0) {
    const currentModel = retries === 1 ? fallbackModel : primaryModel;
    try {
      const messages = [
        {
          role: 'system',
          content: systemInstruction,
        },
      ];

      if (userOverview) {
        messages.push({
          role: 'system',
          content: `[USER PROFILE OVERVIEW FOR u/${userOverview.username}]
${userOverview.data}`,
        });
      }

      if (instructions) {
        messages.push({
          role: 'system',
          content: `[INSTRUCTIONS] ${instructions}`,
        });
      }

      if (chatHistory && chatHistory.length > 0) {
        const historyStr = chatHistory
          .map(
            (m) =>
              `${m.sender === (process.env.REDDIT_USERNAME || 'AskNITJ') ? 'Bot' : 'User'}: ${m.body}`,
          )
          .join('\n');
        messages.push({
          role: 'system',
          content: `[RECENT DM CHAT HISTORY WITH u/${message.sender}]
${historyStr}`,
        });
      }

      messages.push({
        role: 'user',
        content: `=== RETRIEVED CONTEXT ===
${context}
 
Please generate a response for this Direct Message. Keep the persona guidelines in mind and output a valid JSON matching the schema: { "action": "reply" | "query_user" | "reply_with_gif" | "dont_reply", "text": string }.
 
Direct Message to respond to:
[Sender: u/${message.sender}]
Content: ${messageBody}`,
      });

      console.log(chalk.magenta('[DM]') + ` [${message.id}] Requesting completion from NVIDIA API using model ${currentModel}...`);
      const response = await openai.chat.completions.create({
        model: currentModel,
        messages: messages,
        response_format: { type: 'json_object' },
        temperature: 0.7,
      });

      content = response.choices[0].message.content.trim();
      console.log(chalk.magenta('[DM]') + ` [${message.id}] Raw response: ${content}`);

      const responseData = JSON.parse(content);

      const validator = new Validator();
      const validationResult = validator.validate(responseData, responseSchema);
      if (!validationResult.valid) {
        console.error(
          chalk.red('[ERROR]') + ` Schema validation failed for DM ${message.id}:`,
          validationResult.errors,
        );
        retries--;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      if (responseData.action === 'dont_reply') {
        return { action: 'dont_reply', text: '' };
      }

      if (
        responseData.action === 'reply' ||
        responseData.action === 'reply_with_gif'
      ) {
        if (responseData.action === 'reply_with_gif') {
          const gifQuery = responseData.gif_search_query || 'meme';
          console.log(chalk.magenta('[DM]') + ` Searching Giphy for: "${gifQuery}"`);
          const candidates = await searchGiphy(gifQuery);
          if (candidates.length > 0) {
            const choice = await selectBestGif(
              'Direct Message',
              messageBody,
              responseData.text,
              candidates.slice(0, 8),
              currentModel,
            );
            if (choice && choice >= 1 && choice <= candidates.length) {
              const selectedGif = candidates[choice - 1];
              responseData.text = `${responseData.text}\n\n![gif](${selectedGif.url})`;
            }
          }
        }

        return {
          action: 'reply',
          text: `${responseData.text}\n\n*I'm a bot*⋆.˚ ᡣ𐭩 .𖥔˚`,
        };
      } else if (responseData.action === 'query_user') {
        return responseData;
      }
    } catch (err) {
      console.error(chalk.red('[ERROR]') + ` [DM ${message.id}] Error generating response:`, err.message);
      retries--;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return { action: 'dont_reply', text: '' };
}

export { generateDmResponse };
