#!/usr/bin/expect -f

proc forward_stdin {} {
  if {[eof stdin]} {
    return
  }
  set data [read stdin]
  if {$data ne ""} {
    send -raw -- $data
  }
}

set timeout -1
log_user 0
spawn -noecho {*}$argv
fconfigure stdin -blocking 0 -buffering none -translation binary
fileevent stdin readable forward_stdin

set exit_code 1
expect {
  -re {.+} {
    puts -nonewline stdout $expect_out(buffer)
    flush stdout
    exp_continue
  }
  eof {
    catch wait result
    set exit_code [lindex $result 3]
  }
}
exit $exit_code
