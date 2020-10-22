"use strict";

const {
    configure_mocha,
    import_deindented,
    js_getattr,
    one_frame,
    assert,
    pytch_errors,
    assertBuildErrorFun,
} = require("./pytch-testing.js");
configure_mocha();


////////////////////////////////////////////////////////////////////////////////
//
// Machinery to allow more than one loop iteration per frame.

describe("Multiple loop iterations per frame", () => {
    [
        { iters_per_frame: 5, exp_ns: [5, 10, 15, 21, 22] },
        { iters_per_frame: 8, exp_ns: [8, 16, 21, 22, 23] },
        { iters_per_frame: 10, exp_ns: [10, 21, 22, 23, 24] },
        { iters_per_frame: 19, exp_ns: [19, 21, 22, 23, 24] },
        { iters_per_frame: 20, exp_ns: [21, 22, 23, 24, 25] },
        { iters_per_frame: 50, exp_ns: [21, 22, 23, 24, 25] },
    ].forEach(spec => {
        const detail = `${spec.iters_per_frame} iters/frame`;
        it(`obeys loop-yielding-strategy (${detail})`, async () => {
            const n_iters = spec.iters_per_frame;
            const project = await import_deindented(`

                import pytch
                from pytch.syscalls import (
                    push_loop_iterations_per_frame,
                    pop_loop_iterations_per_frame,
                )

                class Counter(pytch.Sprite):
                    Costumes = []

                    @pytch.when_I_receive("run")
                    def run(self):
                        push_loop_iterations_per_frame(${n_iters})
                        self.n = 0
                        for i in range(20):
                            self.n += 1
                        pop_loop_iterations_per_frame()
                        for i in range(5):
                            self.n += 1
            `);

            const counter_0 = project.instance_0_by_class_name("Counter");
            const current_n = () => js_getattr(counter_0.py_object, "n");

            project.do_synthetic_broadcast("run");
            let got_ns = [];
            for (let i = 0; i < 5; ++i) {
                one_frame(project);
                got_ns.push(current_n());
            }

            assert.deepEqual(got_ns, spec.exp_ns);
        });
    });

    it("rejects invalid pop_loop_iterations_per_frame() calls", async () => {
        const project = await import_deindented(`

            import pytch
            from pytch.syscalls import (
                push_loop_iterations_per_frame,
                pop_loop_iterations_per_frame,
            )

            class Counter(pytch.Sprite):
                Costumes = []

                @pytch.when_I_receive("trouble")
                def run(self):
                    push_loop_iterations_per_frame(30)
                    pop_loop_iterations_per_frame()
                    pop_loop_iterations_per_frame()
        `);

        project.do_synthetic_broadcast("trouble");
        one_frame(project);

        const errs = pytch_errors.drain_errors();
        assert.strictEqual(errs.length, 1);

        const err_str = errs[0].err.toString();
        assert.ok(/cannot pop the base/.test(err_str));
    });

    [
        { label: "string", code_fragment: '"banana"' },
        { label: "non-integer", code_fragment: "3.25" },
        { label: "non-positive", code_fragment: "0" },
    ].forEach(spec =>
        it("rejects bad push_loop_iterations_per_frame() call (${spec.label})",
           async () => {
               const project = await import_deindented(`

                   import pytch
                   from pytch.syscalls import (
                       push_loop_iterations_per_frame,
                   )

                   class Counter(pytch.Sprite):
                       Costumes = []

                       @pytch.when_I_receive("trouble")
                       def run(self):
                           push_loop_iterations_per_frame(${spec.code_fragment})
               `);

               project.do_synthetic_broadcast("trouble");
               one_frame(project);

               const errs = pytch_errors.drain_errors();
               assert.strictEqual(errs.length, 1);

               const err_str = errs[0].err.toString();
               assert.ok(/positive integer required/.test(err_str));
           })
    );

    [
        { call_nub: "push", code: "push_loop_iterations_per_frame(3)" },
        { call_nub: "pop", code: "pop_loop_iterations_per_frame()" },
    ].forEach(spec =>
        it(`rejects loop-yield-strategy call at top level (${spec.call_nub})`,
           async () => {
               const build_error_match = new RegExp(
                   `cannot ${spec.call_nub} .* outside a Thread`);

               const full_code = `

                   import pytch
                   from pytch.syscalls import (
                       push_loop_iterations_per_frame,
                       pop_loop_iterations_per_frame,
                   )
                   ${spec.code}
               `;

               await assert.rejects(
                   import_deindented(full_code),
                   assertBuildErrorFun("import",
                                       Sk.builtin.RuntimeError,
                                       build_error_match));
           })
    );

    [
        {
            label: "directly",
            code_suffix: "",
            exp_ns: [1, 2, 3, 4, 15, 16, 17, 18, 19, 20, 20, 20, 20, 20, 20],
        },
        {
            label: "two-phase with 5",
            code_suffix: "(5)",
            exp_ns: [1, 2, 3, 4, 10, 15, 16, 17, 18, 19, 20, 20, 20, 20, 20],
        },
        {
            label: "two-phase with 8",
            code_suffix: "(8)",
            exp_ns: [1, 2, 3, 4, 13, 15, 16, 17, 18, 19, 20, 20, 20, 20, 20],
        },
        {
            label: "two-phase with 9",
            code_suffix: "(9)",
            exp_ns: [1, 2, 3, 4, 14, 15, 16, 17, 18, 19, 20, 20, 20, 20, 20],
        },
        {
            label: "two-phase with 10",
            code_suffix: "(10)",
            exp_ns: [1, 2, 3, 4, 15, 16, 17, 18, 19, 20, 20, 20, 20, 20, 20],
        },
        {
            label: "two-phase with 50",
            code_suffix: "(50)",
            exp_ns: [1, 2, 3, 4, 15, 16, 17, 18, 19, 20, 20, 20, 20, 20, 20],
        },
    ].forEach(spec => {
        it(`can push/pop via context manager (${spec.label})`, async () => {
            const project = await import_deindented(`

                import pytch

                class Counter(pytch.Sprite):
                    Costumes = []

                    @pytch.non_yielding_loops${spec.code_suffix}
                    def count_up_by_ten(self):
                        for i in range(10):
                            self.n += 1

                    def count_up_by_five(self):
                        for i in range(5):
                            self.n += 1

                    @pytch.when_I_receive("run")
                    def run(self):
                        self.n = 0
                        self.count_up_by_five()
                        self.count_up_by_ten()
                        self.count_up_by_five()
            `);

            const counter_0 = project.instance_0_by_class_name("Counter");
            const current_n = () => js_getattr(counter_0.py_object, "n");

            project.do_synthetic_broadcast("run")

            let got_ns = [];
            for (let i = 0; i < 15; ++i) {
                one_frame(project);
                got_ns.push(current_n());
            }

            assert.deepEqual(got_ns, spec.exp_ns);
        });
    });

    it("handles nested loops properly", async () => {
        const project = await import_deindented(`

            import pytch

            class Counter(pytch.Sprite):
                Costumes = []

                @pytch.non_yielding_loops
                def count_ten(self):
                    for i in range(10):
                        self.n += 1

                @pytch.when_I_receive("run")
                def run(self):
                    self.n = 0
                    for i in range(5):
                        self.n += 1
                        self.count_ten()
        `);

        const counter_0 = project.instance_0_by_class_name("Counter");
        const current_n = () => js_getattr(counter_0.py_object, "n");

        project.do_synthetic_broadcast("run");

        let got_ns = [];
        for (let i = 0; i < 7; ++i) {
            one_frame(project);
            got_ns.push(current_n());
        }

        assert.deepEqual(got_ns, [11, 22, 33, 44, 55, 55, 55]);
    });
});
