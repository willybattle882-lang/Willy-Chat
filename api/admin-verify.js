export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  const { token } = req.body
  if (token === process.env.ADMIN_SECRET_TOKEN) {
    res.status(200).json({ valid: true })
  } else {
    res.status(401).json({ error: 'Invalid token' })
  }
}
