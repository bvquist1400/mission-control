import type { NextRequest } from "next/server";
import { craftGet } from "@/lib/craft/http";
export async function GET(request: NextRequest) {
  return craftGet(request);
}
