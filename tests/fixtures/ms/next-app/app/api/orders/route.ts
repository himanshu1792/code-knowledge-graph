export async function GET() {
  return Response.json([]);
}

export async function POST(req: Request) {
  const body = await req.json();
  return Response.json({ created: body });
}
