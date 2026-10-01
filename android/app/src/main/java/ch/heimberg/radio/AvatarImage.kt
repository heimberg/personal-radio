package ch.heimberg.radio

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * A profile picture as it goes to the Worker: the middle square of the photo, 256 px, JPEG. Only this
 * small version leaves the phone.
 */
object AvatarImage {
    private const val SIZE = 256

    /** Reads the photo at about twice the final size, so a camera photo does not fill the memory. */
    fun fromUri(resolver: ContentResolver, uri: Uri): Bitmap? = runCatching {
        // ImageDecoder turns the photo upright; older Androids read it as stored.
        if (Build.VERSION.SDK_INT >= 28) ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            decoder.setTargetSampleSize(sampleSize(info.size.width, info.size.height))
        } else {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight) }) }
        }
    }.getOrNull()

    private fun sampleSize(width: Int, height: Int): Int {
        var sample = 1
        while (minOf(width, height) / (sample * 2) >= SIZE * 2) sample *= 2
        return sample
    }

    /** Base64 of the square, scaled JPEG. */
    fun encode(bitmap: Bitmap): String {
        val side = minOf(bitmap.width, bitmap.height)
        val square = Bitmap.createBitmap(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side)
        val scaled = Bitmap.createScaledBitmap(square, SIZE, SIZE, true)
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 85, out)
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }
}
