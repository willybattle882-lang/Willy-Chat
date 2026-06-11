import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service key — tem permissão total
)

function verifyToken(token) {
  if (!token) return false
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8')
    const [prefix, timestamp] = decoded.split(':')
    if (prefix !== 'admin') return false
    const TWO_HOURS = 2 * 60 * 60 * 1000
    return Date.now() - parseInt(timestamp) <= TWO_HOURS
  } catch {
    return false
  }
}

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' })

  const token = req.headers['x-admin-token']
  if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

  const { photoId, photoUrl } = req.body
  if (!photoId) return res.status(400).json({ error: 'photoId required' })

  // Remove likes e comentários
  await db.from('gallery_likes').delete().eq('photo_id', photoId)
  await db.from('gallery_comments').delete().eq('photo_id', photoId)

  // Remove do banco
  const { error } = await db.from('gallery_photos').delete().eq('id', photoId)
  if (error) return res.status(500).json({ error: error.message })

  // Remove do storage
  if (photoUrl) {
    const fileName = photoUrl.split('/PHOTOS/')[1] || photoUrl.split('/').pop()
    await db.storage.from('PHOTOS').remove([fileName])
  }

  return res.status(200).json({ success: true })
}
