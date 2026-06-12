import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' })

  const token = req.headers['x-admin-token']
  if (!token || token !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { photoId, photoUrl } = req.body
  if (!photoId) return res.status(400).json({ error: 'photoId required' })

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  )

  try {
    // Remove dependências
    await supabase.from('gallery_likes').delete().eq('photo_id', photoId)
    await supabase.from('gallery_comments').delete().eq('photo_id', photoId)

    // Remove foto da tabela
    const { error } = await supabase.from('gallery_photos').delete().eq('id', photoId)
    if (error) throw error

    // Remove arquivo do storage (opcional)
    if (photoUrl) {
      const fileName = photoUrl.split('/').pop()
      if (fileName) await supabase.storage.from('PHOTOS').remove([fileName])
    }

    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('Delete error:', err)
    return res.status(500).json({ error: err.message })
  }
}
