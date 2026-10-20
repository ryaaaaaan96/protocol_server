//! Shared bounded JavaScript runtime for table rules, layouts and derived views.
use crate::error::{AppError, Result};
use rquickjs::{CatchResultExt, Context, Runtime, context::intrinsic};
use std::time::{Duration, Instant};

fn fail(message: impl std::fmt::Display) -> AppError {
    AppError::bad(format!("脚本运行环境错误：{message}"))
}

pub(crate) fn engine() -> Result<Context> {
    let runtime = Runtime::new().map_err(fail)?;
    runtime.set_memory_limit(64 * 1024 * 1024);
    runtime.set_max_stack_size(512 * 1024);
    let started = Instant::now();
    let mut interrupts = 0;
    runtime.set_interrupt_handler(Some(Box::new(move || {
        interrupts += 1;
        interrupts > 2_000 || started.elapsed() > Duration::from_secs(2)
    })));
    // Pure synchronous modules: no module loader, host I/O, Date or timers.
    let context = Context::custom::<(
        intrinsic::Eval,
        intrinsic::Json,
        intrinsic::RegExpCompiler,
        intrinsic::RegExp,
        intrinsic::MapSet,
        intrinsic::Promise,
    )>(&runtime)
    .map_err(fail)?;
    context.with(|ctx| {
        ctx.eval::<(), _>("delete Math.random;")
            .catch(&ctx)
            .map_err(fail)
    })?;
    Ok(context)
}
