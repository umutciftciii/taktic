import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const apiUrl =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const cookieHeader = (await cookies()).toString();

  const response = await fetch(`${apiUrl}/admin/uploads/category-image`, {
    method: 'POST',
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
    body: formData,
  });

  const body = await response.text();
  const contentType = response.headers.get('content-type') ?? 'application/json';
  return new NextResponse(body, {
    status: response.status,
    headers: { 'content-type': contentType },
  });
}
