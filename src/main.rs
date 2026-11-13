use std::io::BufRead;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};
use magicshell::api::auth::check_new_password;
use magicshell::config::AppConfig;
use magicshell::error::AppError;
use magicshell::kit::OcError;
use magicshell::kit::config::{OcConfig, load};
use magicshell::kit::identity::users;
use sqlx::SqlitePool;

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    /// TOML configuration file; environment variables MAGICSHELL__KEY override it.
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    /// Without a command the app is served on the configured address.
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Manage password accounts; needs `database` under [app].
    #[command(subcommand)]
    User(UserCommand),
}

#[derive(Subcommand)]
enum UserCommand {
    /// Add a user and ask for the password twice.
    Add {
        name: String,
        #[command(flatten)]
        password: PasswordSource,
    },
    /// Set a new password and ask for it twice.
    Passwd {
        name: String,
        #[command(flatten)]
        password: PasswordSource,
    },
    /// List the users.
    List,
    /// Delete a user and their data.
    Remove { name: String },
}

#[derive(Args)]
struct PasswordSource {
    /// Read the password from one line of standard input instead of asking.
    #[arg(long)]
    password_stdin: bool,
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let cli = Cli::parse();
    let result = match cli.command {
        None => serve(cli.config).await,
        Some(Command::User(cmd)) => user(cli.config, cmd).await,
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

fn read_config(file: Option<PathBuf>) -> Result<(OcConfig, AppConfig), AppError> {
    let cfg: OcConfig = load("magicshell", file.as_deref())?;
    let app = AppConfig::from_config(&cfg)?;
    Ok((cfg, app))
}

async fn serve(file: Option<PathBuf>) -> Result<(), AppError> {
    let (cfg, app) = read_config(file)?;
    let pool = magicshell::app::open_pool(&cfg, &app).await?;
    let router = magicshell::app::build(&cfg, app, pool).await?;
    let listener = tokio::net::TcpListener::bind(cfg.bind)
        .await
        .map_err(|e| OcError::Config(format!("Cannot listen on {}: {e}.", cfg.bind)))?;
    tracing::info!(bind = %cfg.bind, "listening");
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .map_err(OcError::internal)?;
    Ok(())
}

fn invalid(sentence: &str) -> AppError {
    AppError::Invalid(sentence.to_owned())
}

/// 1 to 64 of ASCII letters, digits, `.`, `_` and `-`.
fn check_name(name: &str) -> Result<(), AppError> {
    let fits = (1..=64).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    if fits { Ok(()) } else { Err(invalid("Use 1 to 64 letters, digits, dots, underscores or hyphens in the name.")) }
}

fn read_password(source: &PasswordSource) -> Result<String, AppError> {
    let secret = if source.password_stdin {
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line).map_err(OcError::internal)?;
        line.trim_end_matches(['\r', '\n']).to_owned()
    } else {
        let first = rpassword::prompt_password("Password: ").map_err(OcError::internal)?;
        let again = rpassword::prompt_password("Again: ").map_err(OcError::internal)?;
        if first != again {
            return Err(invalid("The two passwords differ."));
        }
        first
    };
    check_new_password(&secret)?;
    Ok(secret)
}

async fn user(file: Option<PathBuf>, cmd: UserCommand) -> Result<(), AppError> {
    let (cfg, app) = read_config(file)?;
    let Some(pool) = magicshell::app::open_pool(&cfg, &app).await? else {
        return Err(OcError::Config("Accounts are off. Set database under [app] first.".into()).into());
    };
    match cmd {
        UserCommand::Add { name, password } => {
            check_name(&name)?;
            let secret = read_password(&password)?;
            users::create(&pool, &name, Some(&secret), time::OffsetDateTime::now_utc()).await?;
            println!("Added {name}.");
        }
        UserCommand::Passwd { name, password } => {
            let found = find(&pool, &name).await?;
            let secret = read_password(&password)?;
            users::set_password(&pool, found.id, &secret).await?;
            println!("Changed the password of {}.", found.username);
        }
        UserCommand::List => {
            for (user, created) in users::list(&pool).await? {
                println!("{}\t{}", user.username, created.get(..10).unwrap_or(&created));
            }
        }
        UserCommand::Remove { name } => {
            if !users::delete_by_username(&pool, &name).await? {
                return Err(no_user(&name));
            }
            println!("Removed {name}.");
        }
    }
    Ok(())
}

fn no_user(name: &str) -> AppError {
    AppError::Invalid(format!("There is no user {name}."))
}

async fn find(pool: &SqlitePool, name: &str) -> Result<users::User, AppError> {
    users::by_username(pool, name).await?.ok_or_else(|| no_user(name))
}
