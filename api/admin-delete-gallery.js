import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  // CORS e método
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Token de admin
  const token = req.headers['x-admin-token']
  const expectedToken = process.env.ADMIN_SECRET_TOKEN || 'admin:1781224769781' // use o mesmo do login
  if (!token || token !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { photoId } = req.body
  if (!photoId) {
    return res.status(400).json({ error: 'Missing photoId' })
  }

  // Supabase client com service role (permite deletar independente de RLS)
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  )

  try {
    // 1. Deletar likes e comentários (se não tiver ON DELETE CASCADE)
    await supabase.from('gallery_likes').delete().eq('photo_id', photoId)
    await supabase.from('gallery_comments').delete().eq('photo_id', photoId)

    // 2. Deletar o registro da foto
    const { error: dbError } = await supabase
      .from('gallery_photos')
      .delete()
      .eq('id', photoId)

    if (dbError) throw dbError

    // 3. Tentar deletar o arquivo do storage (opcional)
    // Se você não precisa, ignore.
    
    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('Delete error:', err)
    return res.status(500).json({ error: err.message })
  }
}
