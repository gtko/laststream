use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use std::sync::{Arc, Mutex};

const DISCORD_APP_ID: &str = "1452620752263319665";

/// Discord Rich Presence for Stremio
/// Handles connection to Discord and activity updates
pub struct DiscordRpc {
    client: Arc<Mutex<Option<DiscordIpcClient>>>,
}

impl Default for DiscordRpc {
    fn default() -> Self {
        Self::new()
    }
}

impl DiscordRpc {
    pub fn new() -> Self {
        Self {
            client: Arc::new(Mutex::new(None)),
        }
    }

    pub fn connect(&self) -> Result<(), String> {
        let mut client_guard = self.client.lock().map_err(|e| e.to_string())?;

        if client_guard.is_some() {
            return Ok(());
        }

        let mut client = DiscordIpcClient::new(DISCORD_APP_ID);

        client
            .connect()
            .map_err(|e| format!("Failed to connect to Discord: {}", e))?;

        *client_guard = Some(client);

        println!("Discord RPC connected");
        Ok(())
    }

    pub fn disconnect(&self) -> Result<(), String> {
        let mut client_guard = self.client.lock().map_err(|e| e.to_string())?;

        if let Some(mut client) = client_guard.take() {
            client
                .close()
                .map_err(|e| format!("Failed to close Discord connection: {}", e))?;
        }

        println!("Discord RPC disconnected");
        Ok(())
    }

    pub fn set_activity(
        &self,
        state: &str,
        details: &str,
        large_image: Option<&str>,
        start_timestamp: Option<i64>,
    ) -> Result<(), String> {
        let mut client_guard = self.client.lock().map_err(|e| e.to_string())?;

        if let Some(ref mut client) = *client_guard {
            let mut payload = activity::Activity::new().state(state).details(details);

            // add assets
            if let Some(image) = large_image {
                payload = payload.assets(
                    activity::Assets::new()
                        .large_image(image)
                        .large_text("Stremio"),
                );
            } else {
                // Default Stremio logo
                payload = payload.assets(
                    activity::Assets::new()
                        .large_image("stremio_logo")
                        .large_text("Stremio"),
                );
            }

            // add timestamps
            if let Some(start) = start_timestamp {
                payload = payload.timestamps(activity::Timestamps::new().start(start));
            }

            client
                .set_activity(payload)
                .map_err(|e| format!("Failed to set activity: {}", e))?;

            println!("Discord activity set: {} - {}", state, details);
        } else {
            return Err("Discord not connected".to_string());
        }

        Ok(())
    }

    /// Clear activity
    pub fn clear_activity(&self) -> Result<(), String> {
        let mut client_guard = self.client.lock().map_err(|e| e.to_string())?;

        if let Some(ref mut client) = *client_guard {
            client
                .clear_activity()
                .map_err(|e| format!("Failed to clear activity: {}", e))?;

            println!("Discord activity cleared");
        }

        Ok(())
    }
}

impl Drop for DiscordRpc {
    fn drop(&mut self) {
        let _ = self.disconnect();
    }
}
