// gemini.js
require('dotenv').config(); // read GEMINI_API_KEY and GEMINI_MODEL from .env
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/**
 * generateSearchParams(query, categories, racks, statuses)
 *
 * Converts a natural language query into structured search parameters.
 * Extended to include:
 *  - toolNames: explicit tool names mentioned by the user (if any)
 *  - categories, racks, statuses: as before
 *  - requestedParameters: array of strings describing which tool parameters the user wants (e.g., ["weight","size","type"])
 *
 * Returns:
 * {
 *   toolNames: string[],
 *   categories: string[],
 *   racks: string[],
 *   statuses: string[],
 *   requestedParameters: string[]
 * }
 *
 * NOTE: This follows the same simple style as your reference gemini.js.
 */
async function generateSearchParams(query, categories = [], racks = [], statuses = []) {
  const systemPrompt = `You are a search query converter for a Tool Manager Inventory system.
Convert the user's natural language query into a structured JSON format.

Output JSON format (ONLY valid JSON, no explanation):

{
  "toolNames": string[],           // exact tool names from DB if the user mentions a specific tool
  "categories": string[],          // categories to filter by
  "racks": string[],               // racks to filter by
  "statuses": string[],            // statuses to filter by
  "requestedParameters": string[]  // parameters the user asks about (e.g., weight, size, model, brand, specifications)
}

Rules:
- Use values only from the available lists when possible.
- If the user mentions a specific tool (e.g., "angle grinder", "cordless drill"), include it in toolNames.
- For requestedParameters, extract what the user explicitly asks about (e.g., "weight", "size", "type", "model", "brand", "batteryCapacity", "specifications") or infer likely parameter names from the query.
- Return empty arrays if no values apply.
- Return ONLY valid JSON, no explanations, no code fences.

User's query: ${query}
Available categories: ${categories}
Available racks: ${racks}
Available statuses: ${statuses}
`;

  const aiResponse = await ai.models.generateContent({
    model: MODEL,
    contents: systemPrompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          toolNames: { type: "array", items: { type: "string" } },
          categories: { type: "array", items: { type: "string" } },
          racks: { type: "array", items: { type: "string" } },
          statuses: { type: "array", items: { type: "string" } },
          requestedParameters: { type: "array", items: { type: "string" } }
        },
        required: ["toolNames", "categories", "racks", "statuses", "requestedParameters"]
      }
    }
  });

  // Guard for different SDK response shapes
  const text = aiResponse && (aiResponse.text || aiResponse.outputText || aiResponse.output?.[0]?.content?.[0]?.text);
  if (!text) {
    console.error('generateSearchParams: AI response missing text field', aiResponse);
    throw new Error('AI response missing text');
  }

  const parsed = JSON.parse(text);
  return {
    toolNames: Array.isArray(parsed.toolNames) ? parsed.toolNames : [],
    categories: Array.isArray(parsed.categories) ? parsed.categories : [],
    racks: Array.isArray(parsed.racks) ? parsed.racks : [],
    statuses: Array.isArray(parsed.statuses) ? parsed.statuses : [],
    requestedParameters: Array.isArray(parsed.requestedParameters) ? parsed.requestedParameters : []
  };
}

/**
 * generateTool(toolText, availableCategories, availableStatuses)
 *
 * Parses a freeform tool description into a structured tool object (same style as your reference).
 */
async function generateTool(toolText, availableCategories = [], availableStatuses = []) {
  const systemPrompt = `You are a tool parser. Convert the user's natural language tool description into a structured JSON object.

Available categories: ${availableCategories.join(', ')}
Available statuses: ${availableStatuses.join(', ')}

Output JSON format (ONLY valid JSON, no explanation):
{
  "name": string,
  "category": string,    // must be from available categories
  "quantity": number,
  "rack": string,
  "status": string,      // must be from available statuses
  "purchaseDate": string // ISO format YYYY-MM-DD
}

Rules:
- Choose the most appropriate category and status from the available lists.
- Parse quantity as a number.
- Parse purchaseDate into ISO format if present; otherwise use today's date.
- Return ONLY valid JSON, no explanations.

Tool Text: ${toolText}
`;

  const aiResponse = await ai.models.generateContent({
    model: MODEL,
    contents: systemPrompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: { type: "string" },
          quantity: { type: "number" },
          rack: { type: "string" },
          status: { type: "string" },
          purchaseDate: { type: "string" }
        },
        required: ["name", "category", "quantity", "rack", "status", "purchaseDate"]
      }
    }
  });

  const text = aiResponse && (aiResponse.text || aiResponse.outputText || aiResponse.output?.[0]?.content?.[0]?.text);
  if (!text) {
    console.error('generateTool: AI response missing text field', aiResponse);
    throw new Error('AI response missing text');
  }

  const parsed = JSON.parse(text);
  return parsed;
}

/**
 * generateToolParameters(toolName, requestedParameters)
 *
 * Helper to instruct AI to produce a JSON list of parameter names and how to map them to DB fields.
 * This function is optional but useful if you want the AI to normalize parameter names (e.g., "weight" -> "specifications.weight" or "specifications where name=weight").
 *
 * Returns:
 * {
 *   parameters: [ "weight", "size", "model", ... ],
 *   mappingHints: { weight: "specifications where name=weight", size: "specifications where name=size" }
 * }
 */
async function generateToolParameters(toolName, requestedParameters = []) {
  const systemPrompt = `You are a tool parameter normalizer. Given a tool name and a list of requested parameter keywords, return a JSON object that:
- lists the requestedParameters (normalized),
- provides mappingHints describing where to find each parameter in the DB document (e.g., "specifications where name=weight", "brand", "model", "tags").

Input:
toolName: ${toolName}
requestedParameters: ${JSON.stringify(requestedParameters)}

Output JSON (ONLY valid JSON, no explanation):
{
  "parameters": string[],          // normalized parameter names
  "mappingHints": {                // mapping hint per parameter
    "<param>": string
  }
}

Rules:
- Normalize common synonyms (e.g., weight -> weight, mass; size -> dimensions, length, width; type -> category/model/brand).
- Use simple mapping hints that a developer can use to query the DB.
`;

  const aiResponse = await ai.models.generateContent({
    model: MODEL,
    contents: systemPrompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          parameters: { type: "array", items: { type: "string" } },
          mappingHints: {
            type: "object",
            additionalProperties: { type: "string" }
          }
        },
        required: ["parameters", "mappingHints"]
      }
    }
  });

  const text = aiResponse && (aiResponse.text || aiResponse.outputText || aiResponse.output?.[0]?.content?.[0]?.text);
  if (!text) {
    console.error('generateToolParameters: AI response missing text field', aiResponse);
    throw new Error('AI response missing text');
  }

  return JSON.parse(text);
}

module.exports = {
  ai,
  MODEL,
  generateSearchParams,
  generateTool,
  generateToolParameters
};