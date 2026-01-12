
require('dotenv').config(); // read the GEMINI_API_KEY and the GEMINI_MODEL from the .env file
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// generateSearchParams(query, categories, locations, statuses)
// Converts a natural language query into structured search params.
// Returns:
// {S
//   toolNames: string[],
//   categories: string[],
//   locations: string[],
//   statuses: string[],
//   requestedParameters: string[]
// }
async function generateSearchParams(query, categories = [], locations = [], statuses = []) {
  const systemPrompt = `You are a search query converter for a Tool Manager Inventory system.
Convert the user's natural language query into a structured JSON format that helps the backend find the right tools and the specific parameters the user asks about.

Output: A JSON object with the following fields, ONLY using values from the available lists above and empty arrays if no values apply:
{
  "toolNames": string[],            // exact tool names from DB if the user mentions a specific tool
  "categories": string[],           // categories to filter by (OR logic)
  "locations": string[],            // locations to filter by (OR logic)
  "statuses": string[],             // statuses to filter by (OR logic)
  "requestedParameters": string[]   // parameters the user asks about (e.g., weight, maxTorque, batteryCapacity)
}

Rules:
- Only use values from the provided lists when possible.
- If the user mentions a specific tool (e.g., "angle grinder", "cordless drill"), include it in toolNames.
- For requestedParameters, extract explicit parameter keywords from the query (e.g., weight, maxTorque, batteryCapacity, voltage) and normalize to camelCase.
- Return empty arrays if no values apply.
- Return ONLY valid JSON, no explanations, no code fences.
- Keep parameter names in camelCase matching the specifications array structure.
- Prefer exact tool names when mentioned; otherwise infer categories/locations/statuses.

Examples:
User: "what is the weight for cordless drill"
Output: {"toolNames":["Cordless Drill"],"categories":[],"locations":[],"statuses":[],"requestedParameters":["weight"]}

User: "show me list of power tools"
Output: {"toolNames":[],"categories":["Power Tools"],"locations":[],"statuses":[],"requestedParameters":[]}

User: "battery capacity and weight for cordless drill"
Output: {"toolNames":["Cordless Drill"],"categories":[],"locations":[],"statuses":[],"requestedParameters":["batteryCapacity","weight"]}

User: "list tools in Workshop A"
Output: {"toolNames":[],"categories":[],"locations":["Workshop A"],"statuses":[],"requestedParameters":[]}

User's query: ${query}
Available Categories: ${categories}
Available Locations: ${locations}
Available Statuses: ${statuses}
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
          locations: { type: "array", items: { type: "string" } },
          statuses: { type: "array", items: { type: "string" } },
          requestedParameters: { type: "array", items: { type: "string" } }
        },
        required: ["toolNames", "categories", "locations", "statuses", "requestedParameters"]
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
    locations: Array.isArray(parsed.locations) ? parsed.locations : [],
    statuses: Array.isArray(parsed.statuses) ? parsed.statuses : [],
    requestedParameters: Array.isArray(parsed.requestedParameters) ? parsed.requestedParameters : []
  };
}

// generateTool(toolText, availableCategories, availableStatuses)
// Parse a freeform tool description into a structured tool object.
async function generateTool(toolText, availableCategories = [], availableStatuses = []) {
  const systemPrompt = `You are a tool parser. Convert the user's natural language tool description into a structured tool format.

Available categories: ${availableCategories.join(', ')}
Available statuses: ${availableStatuses.join(', ')}

Output JSON format:
{
  "name": string,
  "category": string (must be from available categories),
  "brand": string,
  "model": string,
  "quantity": number,
  "location": string,
  "status": string (must be from available statuses),
  "purchaseDate": string (ISO format YYYY-MM-DD),
  "specifications": array of objects with structure [{ "name": string, "value": number|string, "unit": string }],
  "maintenance": string[],  // optional maintenance instructions
  "tags": string[]  // optional tags as string array
}

Rules:
- Extract tool name from the text (use proper capitalization).
- Choose the most appropriate category and status from the available lists.
- Infer quantity and location if mentioned.
- Parse purchase date into ISO format if present.
- Extract specifications into an array of objects with name, value, and unit properties.
- Common specification names: maxTorque, weight, batteryCapacity, voltage, power, speed, etc. (use camelCase).
- Return ONLY valid JSON, no explanation.

Examples:
Input: "Bosch cordless drill GSR 12V-15, 5 units, Workshop A Shelf 2, bought March 2024, 30Nm torque, 1.2kg weight, 2Ah battery"
Output: {
  "name": "Cordless Drill",
  "category": "Power Tools",
  "brand": "Bosch",
  "model": "GSR 12V-15",
  "quantity": 5,
  "location": "Workshop A - Shelf 2",
  "status": "available",
  "purchaseDate": "2024-03-15",
  "specifications": [
    {"name": "maxTorque", "value": 30, "unit": "Nm"},
    {"name": "weight", "value": 1.2, "unit": "kg"},
    {"name": "batteryCapacity", "value": 2, "unit": "Ah"}
  ],
  "maintenance": ["Check battery health monthly", "Clean drill chuck after use"],
  "tags": ["drill", "cordless", "power tool", "Bosch"]
}

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
          brand: { type: "string" },
          model: { type: "string" },
          quantity: { type: "number" },
          location: { type: "string" },
          status: { type: "string" },
          purchaseDate: { type: "string" },
          specifications: { 
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                value: { type: ["number", "string"] },
                unit: { type: "string" }
              },
              required: ["name", "value", "unit"]
            }
          },
          maintenance: { type: "array", items: { type: "string" } },
          tags: { type: "array", items: { type: "string" } }
        },
        required: ["name", "category", "brand", "model", "quantity", "location", "status", "purchaseDate"]
      }
    }
  });

  const text = aiResponse && (aiResponse.text || aiResponse.outputText || aiResponse.output?.[0]?.content?.[0]?.text);
  if (!text) {
    console.error('generateTool: AI response missing text field', aiResponse);
    throw new Error('AI response missing text');
  }

  return JSON.parse(text);
}

module.exports = {
  ai,
  MODEL,
  generateSearchParams,
  generateTool
};