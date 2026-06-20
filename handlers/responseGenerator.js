import OpenAI from 'openai';
import {
  getRelevantContextFromPgvector,
  validateResponseContent,
} from './embedding.js';
import fs from 'fs';
import pkg from 'jsonschema';
const { Validator } = pkg;
import chalk from 'chalk';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
});

const responseSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['reply', 'query_user'] },
    text: { type: 'string' },
  },
  required: ['action', 'text'],
};

async function generateResponse(
  item,
  isDM = false,
  isComment = false,
  additionalContext = '',
) {
  let systemInstructionPath = './assets/systemInstruction.txt';
  let systemInstruction = fs.readFileSync(systemInstructionPath, 'utf-8');
  let title = isDM ? 'Direct Message' : item.title;
  let contentText = isDM ? item.body : item.selftext || '';
  let imageUrl = !isDM && item.post_hint === 'image' ? item.url : null;
  let mimeType = 'image/png';
  let imageData = null;

  if (imageUrl) {
    try {
      const image = await fetch(imageUrl);
      mimeType = image.headers.get('Content-Type') || 'image/png';
      imageData = Buffer.from(await image.arrayBuffer()).toString('base64');
    } catch (error) {
      console.error(
        `Error fetching image for ${isDM ? 'message' : 'post'} ${item.id}:`,
        error.message,
      );
      imageUrl = null;
    }
  }

  let contextText = await getRelevantContextFromPgvector(item, isDM);
  console.log(
    `Context for ${isDM ? 'message' : 'post'} ${item.id} fetched successfully`,
  );
  console.log(`Context: ${contextText.slice(0, 200)}...`);

  if (contextText === 'No context available') {
    console.log(
      `No specific past comments found for ${isDM ? 'message' : 'post'} ${item.id}, using default base wiki context.`,
    );
    contextText =
      'No specific past comments found. Answer using general college knowledge and wiki context.';
  }

  try {
    console.log(
      `Generating response for ${isDM ? 'message' : 'post'} ${item.id}: ${title}`,
    );
    let retries = 3;
    let content = null;
    while (retries > 0) {
      if (!process.env.NVIDIA_API_KEY) {
        console.error(
          `NVIDIA_API_KEY is not defined in the environment variables`,
        );
        return { action: 'reply', text: '0canthelpwiththisquery0' };
      }

      try {
        if (isComment) {
          contextText = '';
        }
        const prompt = `You must respond with a valid JSON object matching the schema: { "action": "reply" | "query_user", "text": string }. For "reply", provide a concise (2-3 lines max), factual, but highly sarcastic, dank, and funny Hinglish reply (Hindi in Latin script) as a senior bhaiya, using the context. Never reply in plain English or standard AI tone. Be human, witty, and reference local lore if it fits. For Production Engineering, focus on core vs tech roles. For "query_user", return the username (without "u/") for user-specific queries (e.g., roasts or "who is"). If unanswerable, return { "action": "reply", "text": "0canthelpwiththisquery0" }. Do not return plain text or invalid JSON. Do not mention any attached placement stats image.
-----------------
        This is the actual query of user.:
Post Title: ${title}
Post Content: ${contentText}
Image URL: ${imageUrl || 'No image provided'}
-----------------
Use below mentioned data only for context and nothing else. Do not answer the questions below, It is for the information retrieval. Only answer the actual query of user in your response which is mentioned above. Again, Do not mention any of the context data in your response. Do not assume the belowmentioned to be part of query, but only the information that may or may not help your generate the actual response:
Subreddit Context (Top Comments):
${contextText}
Additional Context:
${additionalContext}`;

        console.log(chalk.green(prompt));

        const modelName = process.env.GENERATION_MODEL || 'qwen/qwen3.5-122b-a10b';
        const isVisionModel = modelName.includes('vision') || modelName.includes('-vl');

        let userContent;
        if (isVisionModel) {
          userContent = [
            {
              type: 'text',
              text: prompt,
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${fs.readFileSync('./assets/placements2025.jpeg').toString('base64')}`,
              },
            },
          ];
          if (imageData) {
            userContent.push({
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${imageData}`,
              },
            });
          }
        } else {
          userContent = prompt;
        }

        const messages = [
          {
            role: 'system',
            content: systemInstruction,
          },
          {
            role: 'user',
            content: userContent,
          },
        ];

        const response = await openai.chat.completions.create({
          model: modelName,
          messages: messages,
          response_format: { type: 'json_object' },
          temperature: 0.7,
        });

        content = response.choices[0].message.content.trim();
        console.log(
          `Raw model response for ${isDM ? 'message' : 'post'} ${item.id}:`,
          content,
        );

        let responseData;
        try {
          responseData = JSON.parse(content);
        } catch (parseError) {
          console.error(
            `Retry ${4 - retries} failed: Invalid JSON - ${parseError.message}`,
          );
          retries--;
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        if (
          responseData.action === 'reply' &&
          responseData.text.includes('0canthelpwiththisquery0')
        ) {
          return { action: 'reply', text: '0canthelpwiththisquery0' };
        }

        const validator = new Validator();
        const validationResult = validator.validate(
          responseData,
          responseSchema,
        );
        if (!validationResult.valid) {
          console.error(
            `Schema validation failed for ${isDM ? 'message' : 'post'} ${item.id}:`,
            validationResult.errors,
          );
          retries--;
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        if (
          responseData.action === 'reply' &&
          responseData.text &&
          responseData.text.trim()
        ) {
          try {
            const validation = await validateResponseContent(responseData.text);
            console.log(
              `Validation check for ${isDM ? 'message' : 'post'} ${item.id}: Reliable=${validation.isReliable}, CommentCount=${validation.commentCount}`,
            );
          } catch (valErr) {
            console.warn(`Validation check failed/skipped:`, valErr.message);
          }

          return {
            action: 'reply',
            text: `${responseData.text}\n\n*I'm a bot*⋆.˚ ᡣ𐭩 .𖥔˚`,
          };
        } else if (responseData.action === 'query_user') {
          return responseData;
        }

        console.log(`Invalid or empty response, retries left: ${retries}`);
        retries--;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`Retry ${4 - retries} failed:`, error.message);
        retries--;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    console.log(
      `No valid response generated after retries for ${isDM ? 'message' : 'post'} ${item.id}`,
    );
    return { action: 'reply', text: '0canthelpwiththisquery0' };
  } catch (error) {
    console.error(
      `Error generating response for ${isDM ? 'message' : 'post'} ${item.id}:`,
      error.message,
    );
    return { action: 'reply', text: '0canthelpwiththisquery0' };
  }
}

export { generateResponse };
