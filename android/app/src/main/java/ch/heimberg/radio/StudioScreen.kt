package ch.heimberg.radio

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import ch.heimberg.radio.core.Connection

/**
 * «Studio»: the station's settings, day plan and editorial team – the web studio from the private
 * Worker, which recognises the app by its user agent. The first request carries the service token;
 * if Access asks for a login, the one-time PIN by email works here (Google sign-in does not).
 */
@Composable
fun StudioScreen(web: WebView, version: String, actions: RadioActions, padding: PaddingValues) {
    Column(Modifier.fillMaxSize().padding(padding)) {
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Studio", style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.weight(1f))
            Text(version, style = MaterialTheme.typography.bodySmall, color = Nocturne.faint)
            TextButton(onClick = actions::openConnection) { Text("Verbindung") }
        }
        AndroidView(
            factory = { (web.parent as? ViewGroup)?.removeView(web); web },
            modifier = Modifier.fillMaxSize(),
        )
    }
}

/** The studio's web view; created once, so the page keeps its place while other tabs are open. */
@SuppressLint("SetJavaScriptEnabled")
fun studioWebView(context: Context, connection: Connection): WebView = WebView(context).apply {
    // The ground colour shows while the page loads instead of a white flash.
    setBackgroundColor(Nocturne.bg.toArgb())
    CookieManager.getInstance().setAcceptCookie(true)
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.userAgentString = "${settings.userAgentString} PersonalRadioAndroid/1"
    webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val host = request.url.host ?: return true
            if (host == connection.host || host.endsWith(".cloudflareaccess.com")) return false
            // Source links open in the browser, never with the token.
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(request.url.toString())))
            return true
        }
    }
    loadUrl(connection.baseUrl, connection.headers())
}
