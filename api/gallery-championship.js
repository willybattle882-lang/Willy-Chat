import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { photoId } = req.body
  if (!photoId) return res.status(400).json({ error: 'photoId required' })

  const { data: photo } = await db.from('gallery_photos').select('championships').eq('id', photoId).single()
  if (!photo) return res.status(404).json({ error: 'Photo not found' })

  await db.from('gallery_photos').update({ championships: (photo.championships || 0) + 1 }).eq('id', photoId)

  return res.status(200).json({ success: true, championships: (photo.championships || 0) + 1 })
}
