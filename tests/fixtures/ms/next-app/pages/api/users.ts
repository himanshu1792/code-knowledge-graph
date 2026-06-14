export default function handler(req, res) {
  if (req.method === 'POST') {
    res.status(201).json({ ok: true });
  } else {
    res.status(405).end();
  }
}
