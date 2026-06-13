export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { token } = req.body
  if (!token) return res.status(401).json({ valid: false })

  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8')
    const [prefix, timestamp] = decoded.split(':')
    if (prefix !== 'admin') return res.status(401).json({ valid: false })

    // Token válido por 2 horas
    const TWO_HOURS = 2 * 60 * 60 * 1000
    if (Date.now() - parseInt(timestamp) > TWO_HOURS) {
      return res.status(401).json({ valid: false, reason: 'expired' })
    }

    return res.status(200).json({ valid: true })
  } catch {
    return res.status(401).json({ valid: false })
  }
}
