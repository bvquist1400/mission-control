import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import { generateTextWithLlm } from '@/lib/llm';
import { parseExtractionResponse } from '@/lib/extraction';

const QUICK_CAPTURE_SYSTEM_PROMPT = `You are extracting task metadata from unstructured work text pasted by the user (IT ticket body, Slack message, email excerpt, meeting note, etc.) for a personal work dashboard.

ENTERPRISE-SAFETY RULES:
- Do NOT quote or reproduce the input text verbatim.
- Output must be paraphrased and minimal.
- Extract only metadata: actions, checklist steps, IDs/URLs, due hints, stakeholders.
- If unsure, set needs_review=true.

PARSING RULES:
- Extract the most actionable title as a verb phrase (e.g. "Fix login issue for Dr. Martinez").
- If the text contains a ticket ID (e.g. IMS0101522, INC0012345), prefix the title with it.
- If the input is a list of independent action items, extract those into suggested_tasks (one task title per item) and keep suggested_checklist empty.
- Each suggested_tasks item must be a concise task title (verb phrase, max ~80 chars), not a full paragraph.
- If the input is a single task with multiple steps, keep suggested_tasks empty and generate checklist items in suggested_checklist.
- Generate checklist items SPECIFIC to the described work — not generic steps.
- Infer task_type from the nature of the work (see hints below).
- If a due date or deadline is mentioned, extract it. Otherwise null.
- Identify any named people as stakeholder_mentions.

TASK TYPE HINTS:
- IT support request, incident, or system issue → Ticket
- Review, approval, or decision request → Task
- Meeting, agenda, or prep → MeetingPrep
- Follow-up, reminder, or check-in → FollowUp
- Routine admin, closing, validation → Admin
- Development, build, or implementation work → Build

Return ONLY valid JSON with this exact schema:
{
  "title": "string — verb phrase, max ~80 chars",
  "suggested_tasks": ["string array — independent task titles when input is a multi-item list; otherwise []"],
  "suggested_checklist": ["string array — SPECIFIC action items, 2–6 items"],
  "task_type": "Task|Ticket|MeetingPrep|FollowUp|Admin|Build",
  "estimated_minutes": 15|30|60|90|120,
  "due_guess_iso": "YYYY-MM-DD or null",
  "due_confidence": 0.0-1.0,
  "implementation_guess": "string matching a known application name, or null",
  "implementation_confidence": 0.0-1.0,
  "stakeholder_mentions": ["string array"],
  "priority_score": 0-100,
  "needs_review": true|false,
  "blocker": false,
  "waiting_on": null
}`;

function buildQuickCapturePrompt(
  rawText: string,
  implementationNames: string[]
): string {
  return `INPUT TEXT (do not quote verbatim):
${rawText.slice(0, 2000)}

Known application names (match implementation_guess against these only):
${implementationNames.join(', ') || 'None'}`;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const body = (await request.json()) as Record<string, unknown>;

    const rawText = typeof body.raw_text === 'string' ? body.raw_text.trim() : '';
    if (!rawText) {
      return NextResponse.json({ error: 'raw_text is required' }, { status: 400 });
    }

    // Fetch known implementations for context
    const { data: implementations } = await supabase
      .from('implementations')
      .select('name')
      .eq('user_id', userId);

    const implementationNames = (implementations ?? []).map((i: { name: string }) => i.name);

    const generation = await generateTextWithLlm({
      supabase,
      userId,
      feature: 'quick_capture',
      systemPrompt: QUICK_CAPTURE_SYSTEM_PROMPT,
      userPrompt: buildQuickCapturePrompt(rawText, implementationNames),
      temperature: 0.3,
      maxTokens: 1000,
      timeoutMs: 12000,
    });

    if (!generation.text) {
      return NextResponse.json(
        { error: 'LLM did not return a result. Check model configuration.' },
        { status: 502 }
      );
    }

    const extraction = parseExtractionResponse(generation.text);

    return NextResponse.json({
      extraction,
      model: generation.runMeta?.modelId ?? 'unknown',
    });
  } catch (error) {
    console.error('Quick capture parse error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
