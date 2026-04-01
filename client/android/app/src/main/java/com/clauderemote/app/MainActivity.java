package com.clauderemote.app;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.widget.Toast;
import android.util.Log;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "MainActivity";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Request notification permission on Android 13+
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1001);
        }

        WebView webView = getBridge().getWebView();

        // Download listener for APK updates
        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setMimeType(mimetype);
            request.addRequestHeader("User-Agent", userAgent);
            request.setDescription("Downloading update...");
            request.setTitle("claude-remote.apk");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "claude-remote.apk");

            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            dm.enqueue(request);

            Toast.makeText(this, "Downloading APK…", Toast.LENGTH_SHORT).show();
        });

        // Expose native bridge to JavaScript so bootstrap can start/stop the background poller
        webView.addJavascriptInterface(new NativeBridge(), "NativeBridge");
    }

    /**
     * JavaScript interface exposed as window.NativeBridge.
     * Called from the bootstrap page to control the background polling service.
     */
    class NativeBridge {
        @JavascriptInterface
        public void startPollerService(String serverUrl, String authToken) {
            Log.d(TAG, "Starting poller service for " + serverUrl);
            Intent intent = new Intent(MainActivity.this, AttentionPollerService.class);
            intent.putExtra("serverUrl", serverUrl);
            intent.putExtra("authToken", authToken);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent);
            } else {
                startService(intent);
            }
        }

        @JavascriptInterface
        public void stopPollerService() {
            Log.d(TAG, "Stopping poller service");
            Intent intent = new Intent(MainActivity.this, AttentionPollerService.class);
            intent.setAction("STOP");
            startService(intent);
        }

        @JavascriptInterface
        public void openInBrowser(String url) {
            Log.d(TAG, "Opening in browser: " + url);
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            startActivity(intent);
        }
    }
}
