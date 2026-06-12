// pages/api/admin-delete-gallery.js (Pages Router)
import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  // Apenas DELETE
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Verifica token admin
  const adminToken = req.headers['x-admin-token']
  if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { photoId, photoUrl } = req.body
  if (!photoId) {
    return res.status(400).json({ error: 'photoId is required' })
  }

  // Cria cliente Supabase com service role (pula RLS)
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY, // use service role key (nunca exponha)
    {
      auth: { persistSession: false }
    }
  )

  try {
    // 1. Deleta os registros relacionados (likes, comentários)
    await supabase.from('gallery_likes').delete().eq('photo_id', photoId)
    await supabase.from('gallery_comments').delete().eq('photo_id', photoId)

    // 2. Deleta o registro da foto na tabela gallery_photos
    const { error: deleteDbError } = await supabase
      .from('gallery_photos')
      .delete()
      .eq('id', photoId)

    if (deleteDbError) throw deleteDbError

    // 3. Deleta o arquivo do storage (opcional, se você armazena a URL pública)
    if (photoUrl) {
      // Extrai o nome do arquivo da URL
      const filePath = photoUrl.split('/').pop()
      if (filePath) {
        await supabase.storage.from('PHOTOS').remove([filePath])
      }
    }

    return res.status(200).json({ success: true })
  } catch (error) {
    console.error('Erro ao deletar foto:', error)
    return res.status(500).json({ error: error.message })
  }
}
