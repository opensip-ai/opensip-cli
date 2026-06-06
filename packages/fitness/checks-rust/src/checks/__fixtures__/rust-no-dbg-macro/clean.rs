// This service logs via the `log` crate, never the debug-only macro.
// The function-call form without a bang, and the != operator, must not
// false-fire because neither is the macro.
fn main() {
    let x = compute();
    log::info!("computed result: {}", x);
    if x != 0 {
        log::info!("non-zero result");
    }
    let dbgger = describe(x);
    log::info!("{}", dbgger);
}

fn describe(x: i32) -> String {
    format!("value is {}", x)
}

fn compute() -> i32 {
    42
}
