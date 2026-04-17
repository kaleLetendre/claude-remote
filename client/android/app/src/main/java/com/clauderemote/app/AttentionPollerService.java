package com.clauderemote.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;

/**
 * Foreground service that polls the server for attention events and fires
 * Android notifications even when the app is in the background.
 */
public class AttentionPollerService extends Service {
    private static final String TAG = "AttentionPoller";
    private static final String CHANNEL_POLLER = "poller_channel";
    private static final String CHANNEL_PROMPT = "prompt_channel";
    private static final String CHANNEL_IDLE = "idle_channel";
    private static final int FOREGROUND_ID = 1;
    private static final long POLL_INTERVAL = 4000; // 4 seconds

    private Handler handler;
    private String serverUrl;
    private String authToken;
    private final Map<String, Long> lastAttention = new HashMap<>();
    private boolean seeded = false;

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        createNotificationChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            if ("STOP".equals(action)) {
                stopSelf();
                return START_NOT_STICKY;
            }

            String url = intent.getStringExtra("serverUrl");
            String token = intent.getStringExtra("authToken");
            if (url != null && token != null) {
                this.serverUrl = url;
                this.authToken = token;
                this.seeded = false;
                this.lastAttention.clear();
            }
        }

        // Start as foreground service with a persistent (low-priority) notification
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_POLLER)
                .setContentTitle("Claude Remote")
                .setContentText("Background alerts active — you\u2019ll be notified when Claude needs input")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .build();

        startForeground(FOREGROUND_ID, notification);

        // Start polling
        handler.removeCallbacksAndMessages(null);
        handler.post(pollRunnable);

        Log.d(TAG, "Service started, polling " + serverUrl);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        Log.d(TAG, "Service destroyed");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private final Runnable pollRunnable = new Runnable() {
        @Override
        public void run() {
            new Thread(() -> pollServer()).start();
            handler.postDelayed(this, POLL_INTERVAL);
        }
    };

    private void pollServer() {
        if (serverUrl == null || authToken == null) return;

        try {
            URL url = new URL(serverUrl + "/api/sessions");
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Authorization", "Bearer " + authToken);
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);

            int code = conn.getResponseCode();
            if (code != 200) return;

            BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();
            conn.disconnect();

            JSONArray sessions = new JSONArray(sb.toString());

            for (int i = 0; i < sessions.length(); i++) {
                JSONObject s = sessions.getJSONObject(i);
                String id = s.optString("id", "");
                String reason = s.optString("attentionReason", "");
                long attentionAt = s.optLong("attentionAt", 0);
                String name = s.optString("name", "Session");
                String preview = s.optString("attentionPreview", "");

                if (reason.isEmpty() || attentionAt == 0) continue;

                if (!seeded) {
                    // First poll — seed timestamps so we don't fire stale notifications
                    lastAttention.put(id, attentionAt);
                    continue;
                }

                Long lastFired = lastAttention.get(id);
                if (lastFired != null && attentionAt <= lastFired) continue;

                lastAttention.put(id, attentionAt);
                fireNotification(id, name, reason, preview);
            }

            if (!seeded) seeded = true;

        } catch (Exception e) {
            Log.d(TAG, "Poll failed: " + e.getMessage());
        }
    }

    private void fireNotification(String sessionId, String name, String reason, String preview) {
        boolean isPrompt = "prompt".equals(reason);

        String title;
        String body;
        String channel;
        int priority;

        if (isPrompt) {
            title = "\u26a1 " + name + " needs input";
            body = (preview != null && !preview.isEmpty())
                    ? preview.substring(0, Math.min(preview.length(), 120))
                    : "Claude is waiting for your response";
            channel = CHANNEL_PROMPT;
            priority = NotificationCompat.PRIORITY_HIGH;
        } else {
            title = "\u2713 " + name + " — done";
            body = "Output finished";
            channel = CHANNEL_IDLE;
            priority = NotificationCompat.PRIORITY_DEFAULT;
        }

        // Tapping the notification opens the app
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra("sessionId", sessionId);
        intent.putExtra("sessionName", name);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, sessionId.hashCode(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, channel)
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setPriority(priority)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent);

        if (isPrompt) {
            builder.setVibrate(new long[]{0, 200, 100, 200});
            builder.setDefaults(NotificationCompat.DEFAULT_SOUND);
        } else {
            builder.setVibrate(new long[]{0, 100});
        }

        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.notify(sessionId.hashCode() + 1000, builder.build());

        Log.d(TAG, "Fired notification: " + title);
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);

            // Low-priority channel for the persistent "monitoring" notification
            NotificationChannel poller = new NotificationChannel(
                    CHANNEL_POLLER, "Background Monitor",
                    NotificationManager.IMPORTANCE_LOW);
            poller.setDescription("Persistent notification while monitoring Claude sessions");
            nm.createNotificationChannel(poller);

            // High-priority channel for prompts (Claude needs input)
            NotificationChannel prompt = new NotificationChannel(
                    CHANNEL_PROMPT, "Input Required",
                    NotificationManager.IMPORTANCE_HIGH);
            prompt.setDescription("Claude is blocked waiting for your input");
            prompt.enableVibration(true);
            prompt.setVibrationPattern(new long[]{0, 200, 100, 200});
            nm.createNotificationChannel(prompt);

            // Lower-priority channel for idle/done (output finished)
            NotificationChannel idle = new NotificationChannel(
                    CHANNEL_IDLE, "Output Finished",
                    NotificationManager.IMPORTANCE_DEFAULT);
            idle.setDescription("Claude finished working");
            idle.enableVibration(true);
            idle.setVibrationPattern(new long[]{0, 100});
            nm.createNotificationChannel(idle);
        }
    }
}
