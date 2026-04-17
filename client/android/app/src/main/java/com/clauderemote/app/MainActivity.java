package com.clauderemote.app;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.media.AudioAttributes;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.widget.Toast;
import android.util.Log;

import java.util.Locale;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "MainActivity";
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private float ttsRate = 1.1f;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Initialize native TTS
        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                tts.setLanguage(Locale.US);
                tts.setSpeechRate(ttsRate);
                tts.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
                ttsReady = true;
                Log.d(TAG, "TTS initialized");
            } else {
                Log.e(TAG, "TTS init failed: " + status);
            }
        });

        // Request permissions on Android 13+
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{
                "android.permission.POST_NOTIFICATIONS",
                "android.permission.RECORD_AUDIO"
            }, 1001);
        } else {
            requestPermissions(new String[]{"android.permission.RECORD_AUDIO"}, 1002);
        }

        WebView webView = getBridge().getWebView();

        // Allow getUserMedia on HTTP origins (server runs over Tailscale, not HTTPS)
        webView.getSettings().setMediaPlaybackRequiresUserGesture(false);

        // Grant mic/audio permission requests from web content
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });

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

        @JavascriptInterface
        public void speak(String text) {
            if (!ttsReady || text == null || text.isEmpty()) return;
            Log.d(TAG, "TTS speak: " + text.substring(0, Math.min(text.length(), 80)));
            tts.speak(text, TextToSpeech.QUEUE_ADD, null, "voice-" + System.currentTimeMillis());
        }

        @JavascriptInterface
        public void stopSpeaking() {
            if (tts != null) tts.stop();
        }

        @JavascriptInterface
        public void setSpeechRate(float rate) {
            ttsRate = rate;
            if (tts != null) tts.setSpeechRate(rate);
        }

        @JavascriptInterface
        public boolean isTtsReady() {
            return ttsReady;
        }
    }

    @Override
    public void onDestroy() {
        if (tts != null) {
            tts.stop();
            tts.shutdown();
        }
        super.onDestroy();
    }
}
