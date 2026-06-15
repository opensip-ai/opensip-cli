fn main() {
    let x = compute();
    dbg!(x);
    let pair = (x, x * 2);
    dbg![pair.0, pair.1];
    dbg!{ pair };
}

fn compute() -> i32 {
    42
}
