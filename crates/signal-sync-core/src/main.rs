use signal_sync_core::{run_opt, OptimizeInput, OptimizeOutput};

fn main() {
    let mut buf = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf).expect("stdin");
    let input: OptimizeInput = match serde_json::from_str(&buf) {
        Ok(i) => i,
        Err(e) => {
            let out = OptimizeOutput {
                ok: false,
                plan: None,
                error: Some(format!("parse: {e}")),
            };
            println!("{}", serde_json::to_string(&out).unwrap());
            return;
        }
    };
    let out = run_opt(input);
    println!("{}", serde_json::to_string(&out).unwrap());
}
