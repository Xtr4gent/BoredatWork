import { NextResponse } from "next/server";

import { advanceReadyBrackets } from "@/lib/workquiz/bracket";
import { INTERNAL_SCHEDULER_HEADER } from "@/lib/workquiz/constants";
import { readSecret } from "@/lib/workquiz/secrets";

export async function POST(request: Request) {
  const expected = readSecret("WORKQUIZ_CRON_SECRET");
  const actual = request.headers.get(INTERNAL_SCHEDULER_HEADER);

  if (actual !== expected) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const brackets = await advanceReadyBrackets();
  return NextResponse.json({ ok: true, brackets: brackets.length });
}
