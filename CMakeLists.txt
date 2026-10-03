cmake_minimum_required(VERSION 3.16)
project(asciisweeper VERSION 0.12 LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

add_compile_options(-Wall -Wextra)

find_package(Curses REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)

# Version string: "<project version>-<short git commit>", e.g. "0.2-a1b2c3d".
# Falls back to "unknown" if git isn't available or this isn't a checkout
# (e.g. a source tarball with no .git directory).
find_package(Git QUIET)
set(ASCIISWEEPER_GIT_COMMIT "unknown")
if(GIT_FOUND)
    execute_process(
        COMMAND ${GIT_EXECUTABLE} rev-parse --short HEAD
        WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
        OUTPUT_VARIABLE _git_commit_out
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET
        RESULT_VARIABLE _git_result
    )
    if(_git_result EQUAL 0 AND _git_commit_out)
        set(ASCIISWEEPER_GIT_COMMIT "${_git_commit_out}")
    endif()
endif()
set(ASCIISWEEPER_VERSION_STRING "${PROJECT_VERSION}-${ASCIISWEEPER_GIT_COMMIT}")

# Re-run configure when HEAD moves to a different commit, so the version
# string stays current on the next build without needing a manual
# reconfigure. Harmless if .git doesn't exist (nothing to depend on).
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${CMAKE_SOURCE_DIR}/.git/HEAD" "${CMAKE_SOURCE_DIR}/.git/index")

configure_file(src/version.h.in generated/version.h @ONLY)

set(COMMON_SRC src/board.c src/net_io.c)

add_executable(asciisweeper src/main.c src/client_net.c src/avatar.c src/config.c src/uuid.c ${COMMON_SRC})
target_include_directories(asciisweeper PRIVATE ${CURSES_INCLUDE_DIR} ${CMAKE_CURRENT_BINARY_DIR}/generated)
target_link_libraries(asciisweeper PRIVATE ${CURSES_LIBRARIES} OpenSSL::SSL OpenSSL::Crypto)

add_executable(asciisweeper-server src/server.c src/score.c src/uuid.c src/netaddr.c ${COMMON_SRC})
target_include_directories(asciisweeper-server PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/generated)
target_link_libraries(asciisweeper-server PRIVATE OpenSSL::SSL OpenSSL::Crypto Threads::Threads)

# Scoring is pure arithmetic over a finished board, so it is worth testing on
# its own - particularly the cases a live match cannot reach cheaply, such as a
# cleanly cleared board, where board_check_win auto-flags every mine and those
# flags must score for nobody.
#
#   cmake --build build --target score-test && ./build/score-test
add_executable(score-test EXCLUDE_FROM_ALL test/score_test.c src/score.c src/board.c)
target_include_directories(score-test PRIVATE src)

add_executable(uuid-test EXCLUDE_FROM_ALL test/uuid_test.c src/uuid.c)
target_include_directories(uuid-test PRIVATE src)

add_executable(config-test EXCLUDE_FROM_ALL test/config_test.c src/config.c src/avatar.c src/uuid.c)
target_include_directories(config-test PRIVATE src)
target_link_libraries(config-test PRIVATE ${CURSES_LIBRARIES} OpenSSL::Crypto)

add_executable(netaddr-test EXCLUDE_FROM_ALL test/netaddr_test.c src/netaddr.c)
target_include_directories(netaddr-test PRIVATE src)
