import { getNextApiKey } from './apiKeyManager.js';
import { getRelevantContextFromPgvector, validateResponseContent } from './embedding.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import pkg from 'jsonschema';
const { Validator } = pkg;
import chalk from 'chalk';

const responseSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['reply', 'query_user'] },
    text: { type: 'string' },
  },
  required: ['action', 'text'],
};

async function generateResponse(item, isDM = false, isComment = false, additionalContext = '') {
  let systemInstructionPath = './assets/systemInstruction.txt';
  let systemInstruction = fs.readFileSync(systemInstructionPath, 'utf-8');
  let title = isDM ? 'Direct Message' : item.title;
  let contentText = isDM ? item.body : (item.selftext || '');
  let imageUrl = !isDM && item.post_hint === 'image' ? item.url : null;
  let mimeType = 'image/png';
  let imageData = null;

  if (imageUrl) {
    try {
      const image = await fetch(imageUrl);
      mimeType = image.headers.get('Content-Type') || 'image/png';
      imageData = Buffer.from(await image.arrayBuffer()).toString('base64');
    } catch (error) {
      console.error(`Error fetching image for ${isDM ? 'message' : 'post'} ${item.id}:`, error.message);
      imageUrl = null;
    }
  }

  let contextText = await getRelevantContextFromPgvector(item, isDM);
  console.log(`Context for ${isDM ? 'message' : 'post'} ${item.id} fetched successfully`);
  console.log(`Context: ${contextText.slice(0, 200)}...`);

  if (contextText === 'No context available') {
    console.log(`No valid context for ${isDM ? 'message' : 'post'} ${item.id}, returning fallback`);
    return { action: 'reply', text: '0canthelpwiththisquery0' };
  }

  try {
    console.log(`Generating response for ${isDM ? 'message' : 'post'} ${item.id}: ${title}`);
    let retries = 4;
    let content = null;
    while (retries > 0) {
      let apiKeyArray = await getNextApiKey();
      const currentKeyIndex = apiKeyArray[0];
      const apiKey = apiKeyArray[1];
      if (!apiKey) {
        console.error(`No available API keys for ${isDM ? 'message' : 'post'} ${item.id}`);
        return { action: 'reply', text: '0canthelpwiththisquery0' };
      }

      try {
        if (isComment) {
          contextText = ''
        }
        const prompt = `You must respond with a valid JSON object matching the schema: { "action": "reply" | "query_user", "text": string }. For "reply", provide a concise (2-3 lines max), factual response in a friendly, funny tone like a senior bhaiya, based on the context. For Production Engineering, focus on core vs tech roles. For "query_user", return the username (without "u/") for user-specific queries (e.g., roasts or "who is"). If unanswerable, return { "action": "reply", "text": "0canthelpwiththisquery0" }. Do not return plain text or invalid JSON. Do not mention any attached placement stats image.
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
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
          model: retries === 1 ? 'gemini-2.5-flash' : 'gemini-2.5-pro',
          systemInstruction,
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema,
          },
        });
        console.log(`Using API key index ${currentKeyIndex} for ${isDM ? 'message' : 'post'} ${item.id}`);
        console.log(`Using model ${retries === 1 ? 'gemini-2.5-flash' : 'gemini-2.5-pro'}`);
        const result = await model.generateContent([
          { text: prompt },
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: fs.readFileSync('./assets/placements2025.jpeg').toString('base64'),
            },
          },
          ...(imageData
            ? [
                {
                  inlineData: {
                    mimeType,
                    data: imageData,
                  },
                },
              ]
            : []),
        ]);

        content = (await result.response.text()).replace('```json', '').replace('```', '').trim();
        console.log(`Raw model response for ${isDM ? 'message' : 'post'} ${item.id}:`, content);

        let responseData;
        try {
          responseData = JSON.parse(content);
        } catch (parseError) {
          console.error(`Retry ${4 - retries} failed with API key ${currentKeyIndex}: Invalid JSON - ${parseError.message}`);
          retries--;
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        if (responseData.action === 'reply' && responseData.text.includes('0canthelpwiththisquery0')) {
          return { action: 'reply', text: '0canthelpwiththisquery0' };
        }

        const validator = new Validator();
        const validationResult = validator.validate(responseData, responseSchema);
        if (!validationResult.valid) {
          console.error(`Schema validation failed for ${isDM ? 'message' : 'post'} ${item.id}:`, validationResult.errors);
          retries--;
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        if (responseData.action === 'reply' && responseData.text && responseData.text.trim()) {
          const validation = await validateResponseContent(responseData.text);
          console.log(`Validation result for ${isDM ? 'message' : 'post'} ${item.id}: Reliable=${validation.isReliable}, CommentCount=${validation.commentCount}`);
          
          if (!validation.isReliable) {
            console.log(`Response unreliable with ${validation.commentCount} supporting comments`);
            return { action: 'reply', text: '0canthelpwiththisquery0' };
          }

          console.log(`Response deemed reliable with ${validation.commentCount} supporting comments`);
          return { action: 'reply', text: `${responseData.text}\n\n*I'm a bot*⋆.˚ ᡣ𐭩 .𖥔˚` };
        } else if (responseData.action === 'query_user') {
          return responseData;
        }

        console.log(`Invalid or empty response, retries left: ${retries}`);
        retries--;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`Retry ${4 - retries} failed with API key ${currentKeyIndex}:`, error.message);
        retries--;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    console.log(`No valid response generated after retries for ${isDM ? 'message' : 'post'} ${item.id}`);
    return { action: 'reply', text: '0canthelpwiththisquery0' };
  } catch (error) {
    console.error(`Error generating response for ${isDM ? 'message' : 'post'} ${item.id}:`, error.message);
    return { action: 'reply', text: '0canthelpwiththisquery0' };
  }
}

export { generateResponse };