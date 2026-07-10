// Structured-output schemas + system prompts for the two analysis calls.
// Structured Outputs disallows numeric min/max, so ranges are enforced by the
// prompt text and clamped downstream.

const sceneSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'people_count', 'people', 'activities', 'notable_observations',
    'mess_score', 'child_wellbeing', 'environment_risks', 'vibe',
  ],
  properties: {
    people_count: { type: 'integer' },
    people: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['identity', 'confidence', 'doing', 'effort'],
        properties: {
          identity: { type: 'string', description: 'Roster name if confidently matched, else "unknown"' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
          doing: { type: 'string', description: 'Short description of what this person is doing' },
          effort: { type: 'integer', description: '0 idle .. 100 clearly contributing / working hard' },
        },
      },
    },
    activities: { type: 'array', items: { type: 'string' } },
    notable_observations: { type: 'array', items: { type: 'string' } },
    mess_score: { type: 'integer', description: '0 spotless .. 10 total chaos' },
    child_wellbeing: {
      type: 'object',
      additionalProperties: false,
      required: ['risk_level', 'notes'],
      properties: {
        risk_level: { type: 'string', enum: ['none', 'low', 'elevated', 'high'] },
        notes: { type: 'string', description: 'Brief, protective framing: supervision, hazards near children' },
      },
    },
    environment_risks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['risk', 'severity'],
        properties: {
          risk: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
      },
    },
    vibe: {
      type: 'object',
      additionalProperties: false,
      required: ['score', 'label'],
      properties: {
        score: { type: 'integer', description: '0 tense/unhappy .. 100 warm/delightful' },
        label: { type: 'string', description: 'One or two words, e.g. "calm", "chaotic fun", "tense"' },
      },
    },
  },
};

const sceneSystem = `You analyse still frames captured from a household's own security camera, for a light-hearted family kitchen dashboard that everyone in the home can see.

Be objective, concise, and kind. Guidelines:
- Only put a real name in "identity" when the person confidently matches someone in the provided household roster; otherwise use "unknown" with confidence "unknown".
- "effort" (0-100) estimates how much each person appears to be actively contributing or doing something useful in view (tidying, cooking, working) versus lounging. It is playful, not a judgement of worth.
- "mess_score" (0-10): how cluttered/messy the visible space is. 0 = spotless, 10 = total chaos.
- "child_wellbeing": assess safety and supervision of any children in view (hazards nearby, left unattended near risks). Frame protectively. Use "none" when no children are present or no concern exists.
- "environment_risks": visible hazards in the space (spills, sharp objects at edges, trailing cables, hot appliances, blocked exits). Empty array if none.
- "vibe" (0-100): the overall emotional temperature of the scene.
Return only JSON that matches the schema.`;

const escalationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['escalation', 'trend', 'tone', 'summary'],
  properties: {
    escalation: { type: 'integer', description: '0 calm .. 100 heated shouting/conflict' },
    trend: { type: 'string', enum: ['escalating', 'stable', 'de-escalating'] },
    tone: { type: 'string', description: 'e.g. "normal", "banter", "argument", "distress"' },
    summary: { type: 'string', description: 'One short neutral sentence about the exchange' },
  },
};

const escalationSystem = `You monitor a rolling transcript of audio from a household's own room, to power a live "argument meter" on a shared family dashboard.

Rate the current emotional intensity of the exchange:
- "escalation" 0-100: 0 = calm/quiet/friendly, ~40 = animated or bickering, ~70 = clear argument, 100 = heated shouting or distress.
- "trend": is it getting worse ("escalating"), holding ("stable"), or calming ("de-escalating") compared to earlier in the window?
- "tone": a short label for the exchange.
- "summary": one neutral, non-judgemental sentence. Do not take sides or quote verbatim.
Return only JSON that matches the schema.`;

function rosterText(roster) {
  if (!roster || !roster.length) return '(no roster provided — identify everyone as "unknown")';
  return roster.map((p) => `- ${p.name}${p.description ? `: ${p.description}` : ''}`).join('\n');
}

module.exports = { sceneSchema, sceneSystem, escalationSchema, escalationSystem, rosterText };
