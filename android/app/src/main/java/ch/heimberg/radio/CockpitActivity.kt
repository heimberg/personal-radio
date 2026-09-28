package ch.heimberg.radio

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/**
 * The web cockpit inside the app: persona, shows, sources, program clock (YAML) and timeline.
 * The page recognises the app by its user agent and shows only settings; playback stays native.
 * The first request carries the service token; if Access asks for a login, the one-time PIN by
 * email works inside the WebView (Google sign-in does not).
 */
class CockpitActivity : AppCompatActivity() {
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val connection = RadioSettings(this).connection() ?: run { finish(); return }
        // The ground colour shows while the page loads instead of a white flash.
        val web = WebView(this).apply {
            fitsSystemWindows = true
            setBackgroundColor(ContextCompat.getColor(context, R.color.bg))
        }
        setContentView(web)

        CookieManager.getInstance().setAcceptCookie(true)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.userAgentString = "${web.settings.userAgentString} PersonalRadioAndroid/1"
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val host = request.url.host ?: return true
                if (host == connection.host || host.endsWith(".cloudflareaccess.com")) return false
                // Source links open in the browser, never with the token.
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(request.url.toString())))
                return true
            }
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })
        web.loadUrl(connection.baseUrl, connection.headers())
    }
}
