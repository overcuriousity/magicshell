use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use magicshell::config::AppConfig;
use magicshell::error::AppError;
use magicshell::kit::OcError;
use magicshell::kit::config::{OcConfig, load};

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    /// TOML configuration file; environment variables MAGICSHELL__KEY override it.
    #[arg(long)]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve the app on the configured address.
    Serve,
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Serve => serve(cli.config).await,
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

async fn serve(file: Option<PathBuf>) -> Result<(), AppError> {
    let cfg: OcConfig = load("magicshell", file.as_deref())?;
    let app_cfg: AppConfig = AppConfig::from_config(&cfg)?;
    let router = magicshell::app::build(&cfg, app_cfg, None)?;
    let listener = tokio::net::TcpListener::bind(cfg.bind)
        .await
        .map_err(|e| OcError::Config(format!("Cannot listen on {}: {e}.", cfg.bind)))?;
    tracing::info!(bind = %cfg.bind, "listening");
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .map_err(OcError::internal)?;
    Ok(())
}
