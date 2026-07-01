import {
  pool,
  generateEmbedding,
  getAllPostComments,
  cleanRedditText,
} from '../lib/database.js';
import {
  describeImage,
  describeVideo,
  detectMediaType,
  isCrosspostUrl,
  fetchCrosspostContent,
} from './aiHelpers.js';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import crypto from 'crypto';
import chalk from 'chalk';

const wikiDir = './assets/redditPosts/';
const cacheFilePath = './assets/wiki_embeddings_cache.json';

const keywordMatches = [
  {
    pattern: /\b(cse|computer\s*science|cs)\b/i,
    file: 'placements/placements_2026_computer_science_and_engineering.md',
  },
  {
    pattern: /\b(information\s*technology)\b/i,
    file: 'placements/placements_2026_information_technology.md',
  },
  {
    pattern: /\b(ece|electronics|ec)\b/i,
    file: 'placements/placements_2026_electronics_and_communication_engineering.md',
  },
  {
    pattern: /\b(ee|electrical)\b/i,
    file: 'placements/placements_2026_electrical_engineering.md',
  },
  {
    pattern: /\b(ice|instrumentation|control)\b/i,
    file: 'placements/placements_2026_instrumentation_and_control_engineering.md',
  },
  {
    pattern: /\b(mech|mechanical)\b/i,
    file: 'placements/placements_2026_mechanical_engineering.md',
  },
  {
    pattern: /\b(ipe|industrial|production)\b/i,
    file: 'placements/placements_2026_industrial_and_production_engineering.md',
  },
  {
    pattern: /\b(che|chemical)\b/i,
    file: 'placements/placements_2026_chemical_engineering.md',
  },
  {
    pattern: /\b(ce|civil)\b/i,
    file: 'placements/placements_2026_civil_engineering.md',
  },
  {
    pattern: /\b(tt|textile)\b/i,
    file: 'placements/placements_2026_textile_technology.md',
  },
  {
    pattern: /\b(bt|bio|biotech|biotechnology)\b/i,
    file: 'placements/placements_2026_bio_technology.md',
  },
  {
    pattern:
      /\b(placement|placements|package|ctc|salary|highest|average|median|offers|jobs|recruitment|recruiters)\b/i,
    file: 'placements/placements_overview_2026.md',
  },
  {
    pattern:
      /\b(placement|placements|package|ctc|salary|highest|average|median|offers|jobs|recruitment|recruiters)\b/i,
    file: 'placements.txt',
  },
  {
    pattern:
      /\b(hostel|hostels|room|accommodation|mess|cooler|coolers|boys\s*hostel|girls\s*hostel|bh1|bh2|bh5|gh1|gh2)\b/i,
    file: 'hostel.txt',
  },
  {
    pattern:
      /\b(hostel|hostels|room|allotment|booking|portal|online\s*hostel|ha\.nitj\.ac\.in|guesthouse)\b/i,
    file: 'online portal.txt',
  },
  {
    pattern: /\b(fee|fees|rupees|rs|payment|structure|charge|charges)\b/i,
    file: 'fee structure.txt',
  },
  {
    pattern: /\b(branch\s*upgrade|branch\s*change|upgradation|cgpa)\b/i,
    file: 'branch upgrade.txt',
  },
  {
    pattern:
      /\b(reporting|physical\s*reporting|verify|verification|central\s*seminar\s*hall|csh)\b/i,
    file: 'physical reporting.txt',
  },
  {
    pattern:
      /\b(document|documents|certificate|certificates|aadhaar|josaa|csab|migration|medical)\b/i,
    file: 'list of documents.txt',
  },
  {
    pattern:
      /\b(dean|dsw|welcome|loan|laptop|bus|pickup|arrival|vounteer|volunteers)\b/i,
    file: 'email from dean after admission.txt',
  },
  {
    pattern:
      /\b(location|reach|connectivity|station|airport|train|bus|travel|railway)\b/i,
    file: 'location.txt',
  },
  {
    pattern: /\b(company|companies|visit|schedule|calendar|november)\b/i,
    file: 'companies/company_visits_november_2025.md',
  },
  {
    pattern: /\b(company|companies|visit|schedule|calendar|december)\b/i,
    file: 'companies/company_visits_december_2025.md',
  },
  {
    pattern: /\b(company|companies|visit|schedule|calendar|january)\b/i,
    file: 'companies/company_visits_january_2026.md',
  },
  {
    pattern: /\b(company|companies|visit|schedule|calendar|february)\b/i,
    file: 'companies/company_visits_february_2026.md',
  },
  {
    pattern: /\b(company|companies|visit|schedule|calendar|march)\b/i,
    file: 'companies/company_visits_march_2026.md',
  },
];

function cosineSimilarity(vecA, vecB) {
  if (vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
  }
  return dotProduct;
}

function getWikiFiles(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getWikiFiles(fullPath));
    } else {
      if (file.endsWith('.txt') || file.endsWith('.md')) {
        results.push(fullPath);
      }
    }
  });
  return results;
}

function loadWikiEmbeddingsCache() {
  if (fs.existsSync(cacheFilePath)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));
    } catch (e) {
      console.error(
        chalk.red('[ERROR]') + ' Error reading wiki embeddings cache:',
        e.message,
      );
    }
  }
  return {};
}

function saveWikiEmbeddingsCache(cache) {
  try {
    fs.writeFileSync(cacheFilePath, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (e) {
    console.error(
      chalk.red('[ERROR]') + ' Error writing wiki embeddings cache:',
      e.message,
    );
  }
}

function computeSha256(content) {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

async function getWikiEmbeddings() {
  const cache = loadWikiEmbeddingsCache();
  const wikiFiles = getWikiFiles(wikiDir);
  let updated = false;
  const wikiData = [];

  const activePaths = new Set();
  for (const filePath of wikiFiles) {
    const relativePath = path.relative(wikiDir, filePath).replace(/\\/g, '/');
    activePaths.add(relativePath);
  }

  for (const cachedPath of Object.keys(cache)) {
    if (!activePaths.has(cachedPath)) {
      console.log(
        chalk.cyan('[RAG Cache]') +
          ` Removing deleted wiki file from cache: ${cachedPath}`,
      );
      delete cache[cachedPath];
      updated = true;
    }
  }

  for (const filePath of wikiFiles) {
    const relativePath = path.relative(wikiDir, filePath).replace(/\\/g, '/');
    const content = fs.readFileSync(filePath, 'utf-8');
    const sha = computeSha256(content);

    let embedding = null;
    if (cache[relativePath] && cache[relativePath].sha === sha) {
      embedding = cache[relativePath].embedding;
    } else {
      console.log(
        chalk.cyan('[RAG Cache]') +
          ` Generating embedding for new/modified wiki file: ${relativePath}`,
      );
      try {
        const docEmbedOut = await generateEmbedding(content);
        embedding = Array.from(docEmbedOut.data);
        cache[relativePath] = {
          content,
          embedding,
          sha,
        };
        updated = true;
      } catch (error) {
        console.error(
          chalk.red('[ERROR]') +
            ` Error generating embedding for ${relativePath}:`,
          error.message,
        );
        if (cache[relativePath]) {
          embedding = cache[relativePath].embedding;
        }
      }
    }

    if (embedding) {
      wikiData.push({
        name: relativePath,
        content,
        embedding,
      });
    }
  }

  if (updated) {
    saveWikiEmbeddingsCache(cache);
  }

  return wikiData;
}

function cleanJsonString(str) {
  let cleaned = str.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.substring(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.substring(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.substring(0, cleaned.length - 3);
  }
  return cleaned.trim();
}

function buildHierarchyText(comments) {
  const commentMap = new Map();
  const roots = [];

  comments.forEach((c) => {
    commentMap.set(c.id, { ...c, children: [] });
  });

  comments.forEach((c) => {
    const mapped = commentMap.get(c.id);
    if (c.parent_id && commentMap.has(c.parent_id)) {
      commentMap.get(c.parent_id).children.push(mapped);
    } else {
      roots.push(mapped);
    }
  });

  function formatComment(comment, depth = 0) {
    const indent = '  '.repeat(depth);
    let text = `${indent}- u/${comment.author}: ${comment.body.replace(/\n/g, ' ')}\n`;
    comment.children.forEach((child) => {
      text += formatComment(child, depth + 1);
    });
    return text;
  }

  let hierarchyText = '';
  roots.forEach((root) => {
    hierarchyText += formatComment(root, 0);
  });
  return hierarchyText;
}

async function searchTavily(query) {
  try {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      console.warn(
        chalk.yellow('[VISION]') +
          ' TAVILY_API_KEY is not defined. Skipping web search.',
      );
      return '';
    }

    console.log(
      chalk.yellow('[TAVILY SEARCH]') + ` Querying Tavily for: "${query}"`,
    );
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: query,
        search_depth: 'basic',
        include_answer: false,
        max_results: 5,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(
        chalk.red('[ERROR]') +
          ` Tavily Search failed with status ${response.status}: ${errText}`,
      );
      return '';
    }

    const data = await response.json();
    if (!data.results || data.results.length === 0) {
      console.log(
        chalk.yellow('[TAVILY SEARCH]') + ` No results found for: "${query}"`,
      );
      return '';
    }

    const snippets = data.results.map((res) => {
      return `Title: ${res.title}\nURL: ${res.url}\nDescription: ${res.content}`;
    });

    return snippets.join('\n\n');
  } catch (error) {
    console.error(
      chalk.red('[ERROR]') + ' Error during Tavily search:',
      error.message,
    );
    return '';
  }
}

const comparisonKeywords =
  /\b(iit|iiit|bits|thapar|pec|bhopal|jamshedpur|una|dtu|nsut|lnmiit|mit|vit|srm|manipal|rvce|bmsce|coep|vjti|ict|tiet|lpu|amity|chitkara|cgc|cuchd|vs|versus|comparison|compare|choose\s*between|which\s*is\s*better|better\s*than)\b/i;

async function getRelevantContextFromPgvector(item, isDM) {
  let candidateSources = '';
  try {
    let queryTitle = '';
    let queryBody = '';
    let queryText = '';

    if (typeof item === 'string') {
      queryText = item;
      queryBody = item;
    } else if (item && typeof item === 'object') {
      queryTitle = item.title || '';
      queryBody = item.body || item.selftext || '';
      queryText = isDM ? queryBody : `${queryTitle} ${queryBody}`;
    }

    if (!queryText.trim()) {
      return 'No context available';
    }

    console.log(
      chalk.cyan('[RAG]') +
        ` Generating embedding for query text: "${queryText.slice(0, 80)}..."`,
    );

    const queryEmbedOut = await generateEmbedding(queryText, 'query');
    const queryEmbedding = Array.from(queryEmbedOut.data);
    const embeddingString = `[${queryEmbedding.join(',')}]`;

    const wikiData = await getWikiEmbeddings();
    const rankedWikis = wikiData.map((doc) => {
      let sim = cosineSimilarity(queryEmbedding, doc.embedding);

      for (const rule of keywordMatches) {
        if (rule.pattern.test(queryText) && doc.name === rule.file) {
          sim = Math.max(sim, 0.95);
          console.log(
            chalk.cyan('[RAG Boost]') +
              ` Matched pattern ${rule.pattern} -> Boosting doc: ${doc.name} (Sim: 0.95+)`,
          );
        }
      }

      return { ...doc, similarity: sim };
    });

    const topWikis = rankedWikis
      .filter((doc) => doc.similarity > 0.15)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 4);

    const currentPostId = item && typeof item === 'object' ? item.id : '';

    const vectorPostQuery = currentPostId
      ? `
        SELECT id, title, selftext, author, url, post_hint, video_url, image_description, 1 - (embedding <=> $1) AS similarity
        FROM posts
        WHERE embedding IS NOT NULL AND id != $2
        ORDER BY similarity DESC
        LIMIT 10
      `
      : `
        SELECT id, title, selftext, author, url, post_hint, video_url, image_description, 1 - (embedding <=> $1) AS similarity
        FROM posts
        WHERE embedding IS NOT NULL
        ORDER BY similarity DESC
        LIMIT 10
      `;

    const vectorPostQueryParams = currentPostId
      ? [embeddingString, currentPostId]
      : [embeddingString];
    const vectorPostResult = await pool.query(
      vectorPostQuery,
      vectorPostQueryParams,
    );

    const cleanTokens = queryText
      .replace(/[^\w\s]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6);

    const tsQuery = cleanTokens.join(' | ');

    let keywordPostResult = { rows: [] };
    if (tsQuery) {
      try {
        const keywordPostQuery = currentPostId
          ? `
            SELECT id, title, selftext, author, url, post_hint, video_url, image_description
            FROM posts
            WHERE to_tsvector('english', title || ' ' || coalesce(selftext, '')) @@ to_tsquery('english', $1) AND id != $2
            LIMIT 10
          `
          : `
            SELECT id, title, selftext, author, url, post_hint, video_url, image_description
            FROM posts
            WHERE to_tsvector('english', title || ' ' || coalesce(selftext, '')) @@ to_tsquery('english', $1)
            LIMIT 10
          `;
        const keywordPostQueryParams = currentPostId
          ? [tsQuery, currentPostId]
          : [tsQuery];
        keywordPostResult = await pool.query(
          keywordPostQuery,
          keywordPostQueryParams,
        );
      } catch (error) {
        console.warn(
          chalk.red('[ERROR]') +
            ` Keyword search for posts failed: ${error.message}`,
        );
      }
    }

    const combinedPosts = [
      ...vectorPostResult.rows,
      ...keywordPostResult.rows,
    ].reduce((acc, row) => {
      acc[row.id] = acc[row.id] || row;
      const similarity = row.similarity !== undefined ? row.similarity : 0.3;
      acc[row.id].similarity = Math.max(
        acc[row.id].similarity || 0,
        similarity,
      );
      return acc;
    }, {});

    const sortedPosts = Object.values(combinedPosts)
      .filter((post) => (post.similarity || 0) > 0.2)
      .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
      .slice(0, 3);

    const vectorCommentQuery = `
      SELECT id, post_id, body, author, parent_id, 1 - (embedding <=> $1) AS similarity
      FROM comments
      WHERE embedding IS NOT NULL AND author != $2
      ORDER BY similarity DESC
      LIMIT 10
    `;
    const vectorCommentResult = await pool.query(vectorCommentQuery, [
      embeddingString,
      process.env.REDDIT_USERNAME || 'AskNITJ',
    ]);

    let keywordCommentResult = { rows: [] };
    if (tsQuery) {
      try {
        const keywordCommentQuery = `
          SELECT id, post_id, body, author, parent_id
          FROM comments
          WHERE to_tsvector('english', body) @@ to_tsquery('english', $1) AND author != $2
          LIMIT 10
        `;
        keywordCommentResult = await pool.query(keywordCommentQuery, [
          tsQuery,
          process.env.REDDIT_USERNAME || 'AskNITJ',
        ]);
      } catch (error) {
        console.warn(
          chalk.red('[ERROR]') +
            ` Keyword search for comments failed: ${error.message}`,
        );
      }
    }

    const combinedComments = [
      ...vectorCommentResult.rows,
      ...keywordCommentResult.rows,
    ].reduce((acc, row) => {
      acc[row.id] = acc[row.id] || row;
      const similarity = row.similarity !== undefined ? row.similarity : 0.3;
      acc[row.id].similarity = Math.max(
        acc[row.id].similarity || 0,
        similarity,
      );
      return acc;
    }, {});

    const sortedComments = Object.values(combinedComments)
      .filter((comment) => (comment.similarity || 0) > 0.2)
      .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
      .slice(0, 5);

    candidateSources = '';
    let docId = 1;

    let searchResults = '';
    if (comparisonKeywords.test(queryText)) {
      console.log(
        chalk.cyan('[RAG]') +
          ` Comparison intent detected. Fetching live internet context...`,
      );
      searchResults = await searchTavily(queryText.slice(0, 400));
      if (searchResults && searchResults.trim()) {
        candidateSources += `=== LIVE INTERNET SEARCH RESULTS ===\n[Document #${docId++}] Source: Tavily Live Search Results\nContent:\n${searchResults}\n---\n`;
      }
      console.log(
        chalk.cyan('[RAG]') +
          ` Tavily search results length: ${searchResults.length} characters`,
      );
    }

    if (topWikis.length > 0) {
      candidateSources += `=== WIKI DOCUMENTS ===\n`;
      for (const wiki of topWikis) {
        candidateSources += `[Document #${docId++}] Source: Wiki File (${wiki.name})\nContent:\n${wiki.content}\n---\n`;
      }
    }

    if (sortedPosts.length > 0) {
      candidateSources += `=== PAST REDDIT POSTS & DISCUSSIONS ===\n`;
      for (const post of sortedPosts) {
        candidateSources += `[Document #${docId++}] Source: Past Reddit Post (Title: ${post.title}, Author: u/${post.author})\n`;
        candidateSources += `Post Body:\n${post.selftext || 'No content'}\n`;

        if (post.image_description) {
          candidateSources += `[Post Media Description: ${post.image_description}]\n`;
        }

        const postComments = await getAllPostComments(post.id, []);
        const filteredComments = postComments.filter(
          (c) =>
            c.author !== (process.env.REDDIT_USERNAME || 'AskNITJ') &&
            c.author !== 'AutoModerator',
        );
        if (filteredComments.length > 0) {
          candidateSources += `Comments Hierarchy (Discussion Thread):\n`;
          candidateSources += buildHierarchyText(filteredComments);
        } else {
          candidateSources += `Comments: No comments\n`;
        }
        candidateSources += `---\n`;
      }
    }

    if (sortedComments.length > 0) {
      candidateSources += `=== OTHER RELEVANT REDDIT COMMENTS ===\n`;
      for (const comment of sortedComments) {
        let postTitleStr = 'Unknown Post';
        let postSelftextStr = '';
        try {
          const postResult = await pool.query(
            'SELECT title, selftext, url, video_url, image_description FROM posts WHERE id = $1',
            [comment.post_id],
          );
          if (postResult.rows.length > 0) {
            const pRow = postResult.rows[0];
            postTitleStr = pRow.title;
            postSelftextStr = pRow.selftext || '';

            if (pRow.image_description) {
              postSelftextStr += `\n[Post Media Description: ${pRow.image_description}]`;
            }
          }
        } catch (dbErr) {
          console.warn(
            chalk.red('[ERROR]') +
              ` Failed to fetch post details for comment ${comment.id}: ${dbErr.message}`,
          );
        }

        let parentCommentStr = '';
        if (comment.parent_id && comment.parent_id !== comment.post_id) {
          try {
            const parentResult = await pool.query(
              'SELECT author, body FROM comments WHERE id = $1',
              [comment.parent_id],
            );
            if (parentResult.rows.length > 0) {
              const parent = parentResult.rows[0];
              parentCommentStr = `[PARENT COMMENT BY u/${parent.author}] ${parent.body.replace(/\n/g, ' ')}`;
            }
          } catch (dbErr) {
            console.warn(
              chalk.red('[ERROR]') +
                ` Failed to fetch parent comment details for comment ${comment.id}: ${dbErr.message}`,
            );
          }
        }

        candidateSources += `[Document #${docId++}] Source: Reddit Comment (Author: u/${comment.author}, Post ID: ${comment.post_id})\n`;
        candidateSources += `Post context of this comment:\n`;
        candidateSources += `- Post Title: ${postTitleStr}\n`;
        if (postSelftextStr) {
          candidateSources += `- Post Body: ${postSelftextStr.slice(0, 300).replace(/\n/g, ' ')}${postSelftextStr.length > 300 ? '...' : ''}\n`;
        }
        if (parentCommentStr) {
          candidateSources += `Parent comment context:\n- ${parentCommentStr}\n`;
        }
        candidateSources += `Actual Comment Content:\n${comment.body}\n---\n`;
      }
    }

    if (!candidateSources.trim()) {
      return 'No context available';
    }

    console.log(chalk.cyan('[RAG]') + ' Candidate sources prepared.');

    if (!process.env.NVIDIA_API_KEY) {
      console.warn(
        chalk.yellow('[RAG]') +
          ' NVIDIA_API_KEY is not defined, returning raw retrieved text.',
      );
      return candidateSources;
    }

    const openai = new OpenAI({
      apiKey: process.env.NVIDIA_API_KEY,
      baseURL: 'https://integrate.api.nvidia.com/v1',
    });

    const systemPrompt = `You are the RAG (Retrieval-Augmented Generation) engine for AskNITJ, a bot helping students at NIT Jalandhar.
Your task is to compile a comprehensive, highly specific, and structured context block from the candidate documents.

Instructions:
1. Identify the core question/need of the query.
2. Filter out all bot spam, AutoModerator comments, duplicate text, and irrelevant noise.
3. Compile a detailed context block organized into two distinct sections if the data is available in the sources:
   - **OFFICIAL WIKI / PLACEMENT / ACADEMIC DATA**: Include ALL relevant verified facts, numbers, CTC statistics (highest, average, lowest, packages), timelines, dates, rules, or contacts from the wiki files. Do NOT summarize or shorten numbers; retain all key details.
   - **REDDIT DISCUSSION CONSENSUS & OPINIONS**: Summarize the student consensus, advice, and opinions from the retrieved past posts and comments. Be specific about what advice was given. **Crucial**: Distinctly separate the consensus of the *query-specific thread* (the comments directly under the queried post) from other general/unrelated discussions. Do not merge or conflate opinions from other posts with the target post's specific thread.
4. **CRITICAL GUIDELINE ON ENTITY PRECISION & FAITHFULNESS**:
   - Be extremely precise with names, institutes, and branches. Do NOT confuse or conflate distinct entities. Keep departments at different colleges strictly separate.
   - Report the Reddit thread consensus faithfully. Summarize the advice given by users objectively as stated in the comments.
   - **DO NOT BE OVERLY STRICT**: If the query is informal, social, or about campus life (e.g. canteens, libraries, hostels, csh, canteens locations, canteens on 5th floor, campus jokes, canteens names like Snackers), you MUST mark \`has_relevant_info\` as \`true\` and include all candidate comments or posts mentioning these locations, canteens, rules, or student tips under the REDDIT DISCUSSION CONSENSUS & OPINIONS section so that the bot has this background information.
5. The output must be comprehensive, highly detailed, and thorough. Do not abbreviate, omit key metrics, or cut off early.
6. Format the output as a valid JSON object matching this schema:
{
  "has_relevant_info": boolean,
  "context": string
}
7. Do not include any greeting, intro, conversational filler, or Markdown formatting outside the JSON object. Do not output anything other than the JSON object.`;

    const messages = [
      {
        role: 'user',
        content: `${systemPrompt}

[QUERY TYPE] ${isDM ? 'Direct Message' : 'Reddit Post'}
[QUERY TITLE] ${queryTitle || 'N/A'}
[QUERY BODY] ${queryBody || 'N/A'}

Here are the raw retrieved candidate documents from the database and wiki. Please extract and synthesize only the relevant facts that can help answer the query:

${candidateSources}`,
      },
    ];

    const primaryModel =
      process.env.GENERATION_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b';
    const fallbackModel =
      process.env.FALLBACK_GENERATION_MODEL || 'meta/llama-3.1-70b-instruct';
    let retries = 3;

    while (retries > 0) {
      const currentModel = retries === 1 ? fallbackModel : primaryModel;
      try {
        console.log(
          chalk.cyan('[RAG]') +
            ` Querying synthesis model: ${currentModel} (attempt ${4 - retries}/3)`,
        );

        const response = await openai.chat.completions.create({
          model: currentModel,
          messages: messages,
          response_format: { type: 'json_object' },
          temperature: 0.1,
        });

        const synthesizedText = response.choices[0].message.content.trim();
        const cleanedJson = cleanJsonString(synthesizedText);
        const resultObj = JSON.parse(cleanedJson);

        if (
          resultObj.context &&
          resultObj.context.trim() &&
          resultObj.context !== 'No context available'
        ) {
          console.log(
            chalk.cyan('[RAG]') +
              ` LLM compiled context. Length: ${resultObj.context.length} chars. (has_relevant_info: ${resultObj.has_relevant_info})`,
          );
          return resultObj.context;
        }

        console.log(
          chalk.cyan('[RAG]') +
            ' LLM determined no context is relevant. Falling back to raw candidate sources.',
        );
        return candidateSources;
      } catch (error) {
        console.error(
          chalk.red('[ERROR]') +
            ` [RAG] Failed to compile context on attempt ${4 - retries}/3:`,
          error.message,
        );
        retries--;
        if (retries > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
    return candidateSources || 'No context available';
  } catch (error) {
    console.error(
      chalk.red('[ERROR]') + ' [RAG] Error during pgvector RAG synthesis:',
      error.message,
    );
    return candidateSources || 'No context available';
  }
}

async function storePosts(posts) {
  try {
    let storedCount = 0;
    let skippedCount = 0;
    for (const post of posts) {
      const exists = await pool.query('SELECT id FROM posts WHERE id = $1', [
        post.id,
      ]);
      if (exists.rows.length === 0) {
        let effectiveSelftext = post.selftext || '';
        let effectiveUrl = post.url || '';
        let effectivePostHint = post.post_hint || '';
        let effectiveIsVideo = post.is_video || false;
        let effectiveVideoUrl = post.video_url || '';

        if (!effectiveSelftext && isCrosspostUrl(effectiveUrl)) {
          console.log(
            chalk.green('[STORE]') +
              ` [${post.id}] Crosspost detected, fetching original...`,
          );
          const original = await fetchCrosspostContent(effectiveUrl);
          if (original) {
            const parts = [];
            const originInfo = original.subreddit
              ? ` from r/${original.subreddit}`
              : '';
            if (original.title && original.title !== post.title) {
              parts.push(
                `[Crossposted${originInfo} — Original Title: "${original.title}"]`,
              );
            } else {
              parts.push(`[Crossposted${originInfo}]`);
            }
            if (original.selftext) {
              parts.push(original.selftext);
            }
            effectiveSelftext = parts.join('\n');
            console.log(
              chalk.green('[STORE]') +
                ` [${post.id}] Built crosspost selftext (${effectiveSelftext.length} chars)`,
            );

            if (!effectivePostHint || effectivePostHint === 'link') {
              effectivePostHint = original.post_hint || effectivePostHint;
            }
            if (!effectiveVideoUrl && original.video_url) {
              effectiveVideoUrl = original.video_url;
            }
            if (original.is_video) {
              effectiveIsVideo = true;
            }
            if (original.url && original.url !== effectiveUrl) {
              effectiveUrl = original.url;
              console.log(
                chalk.green('[STORE]') +
                  ` [${post.id}] Using original URL: ${effectiveUrl}`,
              );
            }
          }
        }

        let imageDescription = '';
        let imageUrl = effectivePostHint === 'image' ? effectiveUrl : null;
        let videoUrl =
          effectiveIsVideo || effectivePostHint === 'hosted:video'
            ? post.secure_media?.reddit_video?.fallback_url ||
              effectiveVideoUrl ||
              ''
            : '';

        if (!imageUrl && !videoUrl) {
          const mediaType = detectMediaType(effectiveUrl);
          if (mediaType === 'image') {
            imageUrl = effectiveUrl;
            console.log(
              chalk.green('[STORE]') +
                ` [${post.id}] Repost detected: link as image (${effectiveUrl})`,
            );
          } else if (mediaType === 'video') {
            if (/^https?:\/\/v\.redd\.it\//i.test(effectiveUrl)) {
              const baseVideoUrl = effectiveUrl.replace(/\/$/, '');
              videoUrl = `${baseVideoUrl}/CMAF_360.mp4?source=fallback`;
              console.log(
                chalk.green('[STORE]') +
                  ` [${post.id}] Repost detected: link as v.redd.it video`,
              );
            } else {
              videoUrl = effectiveUrl;
              console.log(
                chalk.green('[STORE]') +
                  ` [${post.id}] Repost detected: link as video (${effectiveUrl})`,
              );
            }
          }
        }

        if (imageUrl) {
          try {
            console.log(
              chalk.green('[STORE]') +
                ` [${post.id}] Describing image: ${imageUrl.slice(0, 80)}...`,
            );
            const image = await fetch(imageUrl);
            if (!image.ok) {
              console.warn(
                chalk.cyan('[RAG Cache]') +
                  ` [STORE ${post.id}] Image fetch failed (HTTP ${image.status})`,
              );
            } else {
              const mimeType = image.headers.get('Content-Type') || 'image/png';
              const imageData = Buffer.from(await image.arrayBuffer()).toString(
                'base64',
              );
              imageDescription = await describeImage(imageData, mimeType);
              console.log(
                chalk.green('[STORE]') +
                  ` [${post.id}] Image described (${imageDescription.length} chars)`,
              );
            }
          } catch (err) {
            console.warn(
              chalk.red('[ERROR]') +
                ` [STORE ${post.id}] Failed to describe image: ${err.message}`,
            );
          }
        } else if (videoUrl) {
          try {
            console.log(
              chalk.green('[STORE]') +
                ` [${post.id}] Describing video: ${videoUrl.slice(0, 80)}...`,
            );
            imageDescription = await describeVideo(videoUrl);
            console.log(
              chalk.green('[STORE]') +
                ` [${post.id}] Video described (${imageDescription.length} chars)`,
            );
          } catch (err) {
            console.warn(
              chalk.red('[ERROR]') +
                ` [STORE ${post.id}] Failed to describe video: ${err.message}`,
            );
          }
        }

        let rawText = `Post Title: ${post.title}\nPost Content: ${effectiveSelftext || 'No text'}`;
        if (imageDescription) {
          rawText += `\nMedia Description: ${imageDescription}`;
        }
        const text = `${cleanRedditText(rawText)}`;
        const output = await generateEmbedding(text);
        const embedding = Array.from(output.data);
        const embeddingString = `[${embedding.join(',')}]`;
        await pool.query(
          'INSERT INTO posts (id, title, selftext, author, created_utc, url, post_hint, video_url, image_description, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING',
          [
            post.id,
            post.title,
            effectiveSelftext,
            post.author,
            post.created_utc,
            post.url || '',
            post.post_hint || '',
            videoUrl,
            imageDescription || '',
            embeddingString,
          ],
        );

        if (effectiveSelftext && !post.selftext) {
          post.selftext = effectiveSelftext;
        }
        if (imageDescription) {
          post.image_description = imageDescription;
        }
        if (imageUrl) {
          post.post_hint = 'image';
          post.url = imageUrl;
        } else if (videoUrl) {
          post.post_hint = 'hosted:video';
          post.video_url = videoUrl;
          post.is_video = true;
        }

        storedCount++;
        console.log(
          chalk.green('[STORE]') +
            ` Stored new post ${post.id} by ${post.author}: ${post.title}`,
        );
      } else {
        skippedCount++;
        console.log(
          chalk.green('[STORE]') +
            ` Skipped post ${post.id}: Already exists in database`,
        );
      }
    }
    console.log(
      chalk.green('[STORE]') +
        ` Stored ${storedCount} new posts, skipped ${skippedCount} existing posts`,
    );
  } catch (error) {
    console.error(
      chalk.red('[ERROR]') + ' Error storing posts:',
      error.message,
    );
  }
}

async function storeComments(comments) {
  try {
    let storedCount = 0;
    for (const comment of comments) {
      const exists = await pool.query('SELECT id FROM comments WHERE id = $1', [
        comment.id,
      ]);
      if (exists.rows.length === 0) {
        const text = `Comment on Post ${comment.post_id}: ${cleanRedditText(comment.body)}`;
        const output = await generateEmbedding(text);
        const embedding = Array.from(output.data);
        const embeddingString = `[${embedding.join(',')}]`;
        await pool.query(
          'INSERT INTO comments (id, post_id, parent_id, author, body, created_utc, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING',
          [
            comment.id,
            comment.post_id,
            comment.parent_id,
            comment.author,
            comment.body,
            comment.created_utc,
            embeddingString,
          ],
        );
        storedCount++;
        console.log(
          chalk.green('[STORE]') +
            ` Stored new comment ${comment.id} by ${comment.author} on post ${comment.post_id}`,
        );
      }
    }
    console.log(
      chalk.green('[STORE]') +
        ` Stored ${storedCount} new comments in database`,
    );
  } catch (error) {
    console.error(
      chalk.red('[ERROR]') + ' Error storing comments:',
      error.message,
    );
  }
}

async function storeDMs(messages) {
  try {
    let storedCount = 0;
    for (const message of messages) {
      const exists = await pool.query('SELECT id FROM dms WHERE id = $1', [
        message.id,
      ]);
      if (exists.rows.length === 0) {
        const text = `Message: ${cleanRedditText(message.body)}`;
        const output = await generateEmbedding(text);
        const embedding = Array.from(output.data);
        const embeddingString = `[${embedding.join(',')}]`;
        await pool.query(
          'INSERT INTO dms (id, sender, recipient, body, created_utc, embedding) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING',
          [
            message.id,
            message.sender,
            process.env.REDDIT_USERNAME || 'AskNITJ',
            message.body,
            message.created_utc,
            embeddingString,
          ],
        );
        storedCount++;
        console.log(
          chalk.green('[STORE]') +
            ` Stored new DM ${message.id} from ${message.sender}`,
        );
      }
    }
    console.log(
      chalk.green('[STORE]') + ` Stored ${storedCount} new DMs in database`,
    );
  } catch (error) {
    console.error(chalk.red('[ERROR]') + ' Error storing DMs:', error.message);
  }
}

export {
  storePosts,
  storeComments,
  storeDMs,
  getRelevantContextFromPgvector,
  getWikiEmbeddings,
};
