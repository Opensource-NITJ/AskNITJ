import OpenAI from 'openai';
import fs from 'fs';
import pkg from 'jsonschema';
import { execSync } from 'child_process';
import path from 'path';
import fetch from 'node-fetch';
import Reddit from 'reddit';
import chalk from 'chalk';

const { Validator } = pkg;

const openai = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
});

const redditClient = new Reddit({
  username: process.env.REDDIT_USERNAME,
  password: process.env.REDDIT_PASSWORD,
  appId: process.env.REDDIT_APP_ID,
  appSecret: process.env.REDDIT_APP_SECRET,
  userAgent: 'NITJalandhar/1.0.0 (by Opensource@NITJalandhar)',
});

const VISION_MODEL = process.env.VISION_MODEL || 'meta/llama-3.2-90b-vision-instruct';
const FALLBACK_VISION_MODEL = process.env.FALLBACK_VISION_MODEL || 'meta/llama-3.2-11b-vision-instruct';
const VIDEO_VISION_MODEL = process.env.VIDEO_VISION_MODEL || 'qwen/qwen3.5-397b-a17b';
const FALLBACK_VIDEO_VISION_MODEL = process.env.FALLBACK_VIDEO_VISION_MODEL || 'meta/llama-3.2-11b-vision-instruct';

const responseSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['reply', 'query_user', 'reply_with_gif', 'dont_reply'] },
    text: { type: 'string' },
    gif_search_query: { type: 'string' },
  },
  required: ['action', 'text'],
};

const IMAGE_URL_PATTERNS = [
  /^https?:\/\/i\.redd\.it\//i,
  /^https?:\/\/i\.imgur\.com\//i,
  /^https?:\/\/preview\.redd\.it\//i,
  /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i,
];

const VIDEO_URL_PATTERNS = [
  /^https?:\/\/v\.redd\.it\//i,
  /^https?:\/\/streamable\.com\//i,
  /^https?:\/\/gfycat\.com\//i,
  /^https?:\/\/clips\.twitch\.tv\//i,
  /\.(mp4|webm|mov)(\?.*)?$/i,
];

function detectMediaType(url) {
  if (!url) return null;
  for (const pattern of IMAGE_URL_PATTERNS) {
    if (pattern.test(url)) return 'image';
  }
  for (const pattern of VIDEO_URL_PATTERNS) {
    if (pattern.test(url)) return 'video';
  }
  return null;
}

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 3000;

async function describeImage(base64Data, mimeType) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return '';
  
  const content = [
    {
      type: 'text',
      text: 'You are an advanced OCR and visual analyst. Perform a detailed, highly descriptive analysis of this image. Extract EVERY word or phrase present in the image word-for-word (OCR) with complete accuracy. Also describe the visual content, graphics, essence, mood, and context in rich detail. Return only the extracted text and detailed description without any conversational filler.\n\nCRITICAL: Start directly with the analysis. Do NOT include any introductory or conversational preambles (e.g., do not say "I will analyze this...", "Sure, here is...", or "Here is the OCR..."). Go straight to the details.'
    },
    {
      type: 'image_url',
      image_url: {
        url: `data:${mimeType};base64,${base64Data}`
      }
    }
  ];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const currentModel = attempt === 3 ? FALLBACK_VISION_MODEL : VISION_MODEL;
    try {
      console.log(chalk.yellow('[VISION]') + ` Describing post image using ${currentModel} (attempt ${attempt}/${MAX_RETRIES})...`);
      const response = await openai.chat.completions.create({
        model: currentModel,
        messages: [{ role: 'user', content: content }],
        temperature: 0.2,
        max_tokens: 1024,
      });

      const rawContent = response?.choices?.[0]?.message?.content;
      if (!rawContent) {
        console.warn(chalk.yellow('[VISION]') + ` Image API returned empty/null content on attempt ${attempt}`);
        if (attempt < MAX_RETRIES) {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          console.log(chalk.yellow('[VISION]') + ` Retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        return '';
      }

      let description = rawContent.trim();
      description = description.replace(/^(I'll analyze this|I will analyze this|Here is the|Here is a|Sure, here is|Let's analyze).{0,100}?(analysis|description|video|image|meme|frame by frame|ocr).{0,20}?(\n|:)+/i, '');
      description = description.trim();

      console.log(chalk.yellow('[VISION]') + ` Image description: "${description.slice(0, 150)}..."`);
      return description;
    } catch (error) {
      console.error(chalk.red('[ERROR]') + ` [VISION] Failed to describe image (attempt ${attempt}/${MAX_RETRIES}):`, error.message);
      if (attempt < MAX_RETRIES) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(chalk.yellow('[VISION]') + ` Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  console.error(chalk.red('[ERROR]') + ` [VISION] All ${MAX_RETRIES} attempts failed for image description.`);
  return '';
}

function getFfmpegPath() {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return 'ffmpeg';
  } catch (sysErr) {
    console.error(chalk.red('[ERROR]') + ' [VISION] System ffmpeg not found in PATH.');
    return 'ffmpeg';
  }
}

function getFfprobePath() {
  try {
    execSync('ffprobe -version', { stdio: 'ignore' });
    return 'ffprobe';
  } catch (sysErr) {
    console.error(chalk.red('[ERROR]') + ' [VISION] System ffprobe not found in PATH.');
    return 'ffprobe';
  }
}

async function resolveVideoUrl(videoUrl) {
  if (!videoUrl || !/^https?:\/\/v\.redd\.it\//i.test(videoUrl)) {
    return videoUrl;
  }

  const match = videoUrl.match(/^(https?:\/\/v\.redd\.it\/[a-z0-9]+)/i);
  if (!match) return videoUrl;
  const baseUrl = match[1];

  const candidates = [
    `${baseUrl}/CMAF_360.mp4?source=fallback`,
    `${baseUrl}/DASH_360.mp4?source=fallback`,
    `${baseUrl}/CMAF_480.mp4?source=fallback`,
    `${baseUrl}/DASH_480.mp4?source=fallback`
  ];

  console.log(chalk.yellow('[VISION]') + ` Probing video candidates for: ${baseUrl}`);
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        method: 'HEAD',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 5000
      });
      if (response.status === 200) {
        console.log(chalk.yellow('[VISION]') + ` Resolved working video URL: ${candidate}`);
        return candidate;
      }
    } catch (err) {
      // ignore
    }
  }

  return videoUrl;
}

async function describeVideo(rawVideoUrl) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return '';

  const videoUrl = await resolveVideoUrl(rawVideoUrl);

  const ffmpegPath = getFfmpegPath();
  const ffprobePath = getFfprobePath();

  const tempDir = path.join(process.cwd(), 'scratch', `video_temp_${Date.now()}`);
  try {
    fs.mkdirSync(tempDir, { recursive: true });

    let duration = 10;
    try {
      const durationStr = execSync(`"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoUrl}"`, { timeout: 30000 }).toString().trim();
      const parsedDuration = parseFloat(durationStr);
      if (!isNaN(parsedDuration) && parsedDuration > 0) {
        duration = parsedDuration;
        console.log(chalk.yellow('[VISION]') + ` Video duration: ${duration}s`);
      }
    } catch (ffprobeErr) {
      console.warn(chalk.yellow('[VISION]') + ` Failed to probe video duration:`, ffprobeErr.message);
    }

    const fps = (5 / duration).toFixed(4);
    console.log(chalk.yellow('[VISION]') + ` Extracting frames from video URL: ${videoUrl} with fps=${fps}`);
    const outputPattern = path.join(tempDir, 'frame_%03d.jpg');
    execSync(`"${ffmpegPath}" -y -i "${videoUrl}" -vf "fps=${fps}" -vframes 5 "${outputPattern}"`, { stdio: 'ignore', timeout: 60000 });

    const files = fs.readdirSync(tempDir).filter(file => file.endsWith('.jpg')).sort();
    if (files.length === 0) {
      console.log(chalk.yellow('[VISION]') + ' No frames extracted from video.');
      return '';
    }

    console.log(chalk.yellow('[VISION]') + ` Describing video using ${files.length} extracted frames...`);

    const content = [
      {
        type: 'text',
        text: 'These are sequential keyframes from a video post on Reddit. You are an advanced visual analyst. Analyze the visual content, actions, timeline progression, text overlays, speech/subtitles if visible, humor, and story shown across these frames in rich detail. Perform OCR to extract any visible text. Return a detailed, highly descriptive summary of the video without any conversational filler.\n\nCRITICAL: Start directly with the analysis. Do NOT include any introductory or conversational preambles (e.g., do not say "I\'ll analyze this meme video...", "Sure, here is...", or "Let\'s examine..."). Go straight to the details.'
      }
    ];

    for (const file of files) {
      const filePath = path.join(tempDir, file);
      const base64Data = fs.readFileSync(filePath).toString('base64');
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${base64Data}`
        }
      });
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const currentModel = attempt === 3 ? FALLBACK_VIDEO_VISION_MODEL : VIDEO_VISION_MODEL;
      try {
        console.log(chalk.yellow('[VISION]') + ` Calling vision model for video (${currentModel}) (attempt ${attempt}/${MAX_RETRIES})...`);
        const response = await openai.chat.completions.create({
          model: currentModel,
          messages: [{ role: 'user', content: content }],
          temperature: 0.2,
          max_tokens: 1024,
        });

        const rawContent = response?.choices?.[0]?.message?.content;
        if (!rawContent) {
          console.warn(chalk.yellow('[VISION]') + ` Video API returned empty/null content on attempt ${attempt}`);
          if (attempt < MAX_RETRIES) {
            const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            console.log(chalk.yellow('[VISION]') + ` Retrying in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          return '';
        }

        let description = rawContent.trim();
        description = description.replace(/^(I'll analyze this|I will analyze this|Here is the|Here is a|Sure, here is|Let's analyze).{0,100}?(analysis|description|video|image|meme|frame by frame|ocr).{0,20}?(\n|:)+/i, '');
        description = description.trim();

        console.log(chalk.yellow('[VISION]') + ` Video description: "${description.slice(0, 150)}..."`);
        return description;
      } catch (apiError) {
        console.error(chalk.red('[ERROR]') + ` [VISION] Failed to describe video via API (attempt ${attempt}/${MAX_RETRIES}):`, apiError.message);
        if (attempt < MAX_RETRIES) {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          console.log(chalk.yellow('[VISION]') + ` Retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    console.error(chalk.red('[ERROR]') + ` [VISION] All ${MAX_RETRIES} attempts failed for video description.`);
    return '';
  } catch (error) {
    console.error(chalk.red('[ERROR]') + ` [VISION] Failed to describe video:`, error.message);
    return '';
  } finally {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      console.error(chalk.red('[ERROR]') + ` [VISION] Failed to clean up temp dir:`, cleanupError.message);
    }
  }
}

async function fetchImageBase64(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'image/png';
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    return { contentType, base64 };
  } catch (error) {
    console.error(chalk.red('[ERROR]') + ` [GIF FETCH] Failed to fetch still image from ${url}:`, error.message);
    return null;
  }
}

async function searchGiphy(query) {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) {
    console.warn(chalk.yellow('[VISION]') + " GIPHY_API_KEY is not defined. Skipping GIF search.");
    return [];
  }
  
  let cleanedQuery = query;
  if (query.includes('giphy.com/')) {
    try {
      const urlObj = new URL(query);
      const pathname = urlObj.pathname;
      const parts = pathname.split('/').filter(Boolean);
      const lastPart = parts[parts.length - 1];
      if (lastPart) {
        cleanedQuery = decodeURIComponent(lastPart);
      }
    } catch (e) {
      const parts = query.split('/');
      const lastPart = parts[parts.length - 1] || parts[parts.length - 2];
      if (lastPart) {
        cleanedQuery = lastPart;
      }
    }
  }

  cleanedQuery = cleanedQuery.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  
  if (cleanedQuery !== query) {
    console.log(chalk.blue('[GIF SEARCH]') + ` Cleaned search query: "${query}" -> "${cleanedQuery}"`);
  }
  
  const fetchGifs = async (q) => {
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(q)}&limit=8&rating=pg-13`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Giphy API error: ${response.statusText}`);
    }
    const json = await response.json();
    return json.data || [];
  };

  try {
    let data = await fetchGifs(cleanedQuery);
    
    if (data.length === 0 && cleanedQuery.trim().includes(' ')) {
      const words = cleanedQuery.trim().split(/\s+/);
      if (words.length > 2) {
        const simplified = words.slice(0, 2).join(' ');
        console.log(chalk.blue('[GIF SEARCH]') + ` No results for "${cleanedQuery}". Trying simplified query: "${simplified}"`);
        data = await fetchGifs(simplified);
      }
    }
    
    if (data.length === 0 && cleanedQuery.trim().includes(' ')) {
      const firstWord = cleanedQuery.trim().split(/\s+/)[0];
      console.log(chalk.blue('[GIF SEARCH]') + ` No results. Trying first word: "${firstWord}"`);
      data = await fetchGifs(firstWord);
    }

    if (data.length > 0) {
      return data.map(item => ({
        id: item.id,
        url: item.images.original.url,
        title: item.title || 'Untitled GIF',
        alt_text: item.alt_text || '',
        still_url: item.images.fixed_width_still?.url || item.images.original_still?.url || ''
      }));
    }
    return [];
  } catch (error) {
    console.error(chalk.red('[ERROR]') + " Giphy search failed:", error.message);
    return [];
  }
}

async function selectBestGif(
  postTitle,
  postContent,
  replyText,
  candidates,
  modelName,
) {
  const visionModel = modelName || VISION_MODEL;
  
  const candidatesText = candidates.map((c, i) => {
    const desc = c.alt_text ? ` (Description: ${c.alt_text})` : '';
    return `${i + 1}. Title: "${c.title}"${desc} (ID: ${c.id})`;
  }).join('\n');

  const prompt = `You are a helpful assistant. You must select the best GIF from the list below to accompany a Reddit reply.

Post Title: "${postTitle}"
Post Content: "${postContent}"
Our Reply: "${replyText}"

GIF Candidates:
${candidatesText}

Which GIF best fits the context, tone, and humor of our reply?
Respond with a valid JSON object matching the schema: { "choice": number | null }. 
The "choice" field must be the integer index of your selection (1 to ${candidates.length}), or null if none of the candidates fit well or if they are not funny/relevant.
Do not return anything else except the valid JSON.`;

  try {
    let userContent = [
      {
        type: 'text',
        text: prompt
      }
    ];

    const imagePromises = candidates.map(async (c, i) => {
      if (c.still_url) {
        const img = await fetchImageBase64(c.still_url);
        return { index: i + 1, image: img };
      }
      return { index: i + 1, image: null };
    });
    const fetchedImages = await Promise.all(imagePromises);

    fetchedImages.forEach((item) => {
      if (item.image) {
        userContent.push({
          type: 'text',
          text: `--- Still Image for GIF Candidate ${item.index} ---`
        });
        userContent.push({
          type: 'image_url',
          image_url: {
            url: `data:${item.image.contentType};base64,${item.image.base64}`
          }
        });
      }
    });

    const response = await openai.chat.completions.create({
      model: visionModel,
      messages: [{ role: 'user', content: userContent }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    });

    const content = response.choices[0].message.content.trim();
    console.log(chalk.blue('[GIF SELECT]') + ` LLM raw response: ${content}`);
    const result = JSON.parse(content);
    return result.choice;
  } catch (error) {
    console.error(chalk.red('[ERROR]') + ' [GIF SELECT] Error choosing GIF:', error.message);
    return null;
  }
}

function isCrosspostUrl(url) {
  if (!url) return false;
  return /^(\/r\/|https?:\/\/(www\.)?reddit\.com\/r\/)[\w]+\/comments\//i.test(url);
}

async function fetchCrosspostContent(crosspostUrl) {
  try {
    let cleanPath = crosspostUrl;
    if (cleanPath.startsWith('http')) {
      try {
        const urlObj = new URL(cleanPath);
        cleanPath = urlObj.pathname;
      } catch (e) {
        // ignore
      }
    }
    if (!cleanPath.startsWith('/')) {
      cleanPath = '/' + cleanPath;
    }
    cleanPath = cleanPath.replace(/\/$/, '').replace(/\.json$/, '');

    console.log(chalk.cyan('[CROSSPOST]') + ` Fetching original post: ${cleanPath}`);
    const response = await redditClient.get(cleanPath);

    const postData = response?.[0]?.data?.children?.[0]?.data;
    if (!postData) {
      console.warn(chalk.cyan('[CROSSPOST]') + ` Could not parse post data from API response`);
      return null;
    }

    let selftext = postData.selftext || '';
    if (postData.poll_data) {
      const optionsText = postData.poll_data.options
        ? postData.poll_data.options.map((opt, index) => `${index + 1}. ${opt.text}`).join('\n')
        : '';
      if (optionsText) {
        selftext = `${selftext}\n\n[Reddit Poll Options]:\n${optionsText}`.trim();
      }
    }

    const result = {
      selftext: selftext,
      title: postData.title || '',
      url: postData.url || '',
      subreddit: postData.subreddit || '',
      post_hint: postData.post_hint || '',
      is_video: postData.is_video || false,
      video_url: postData.media?.reddit_video?.fallback_url || postData.secure_media?.reddit_video?.fallback_url || '',
    };

    console.log(chalk.cyan('[CROSSPOST]') + ` Fetched original post: "${result.title?.slice(0, 60)}"`);
    return result;
  } catch (error) {
    console.error(chalk.red('[ERROR]') + ` [CROSSPOST] Error fetching crosspost content:`, error.message);
    return null;
  }
}

export {
  openai,
  responseSchema,
  describeImage,
  describeVideo,
  detectMediaType,
  isCrosspostUrl,
  fetchCrosspostContent,
  searchGiphy,
  selectBestGif,
};
