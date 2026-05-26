export default function handler(_request, response) {
  response.status(200).json({
    dailyLimit: Number(process.env.GEMINI_DAILY_LIMIT || 50),
    modelName: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    timezoneBasis: 'America/Los_Angeles',
  });
}
