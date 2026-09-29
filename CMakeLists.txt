cmake_minimum_required(VERSION 3.16)
project(asciisweeper VERSION 0.1 LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

add_compile_options(-Wall -Wextra)

find_package(Curses REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)

# Version string: "<project version>-<short git commit>", e.g. "0.1-a1b2c3d".
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

add_executable(asciisweeper src/main.c src/client_net.c ${COMMON_SRC})
target_include_directories(asciisweeper PRIVATE ${CURSES_INCLUDE_DIR} ${CMAKE_CURRENT_BINARY_DIR}/generated)
target_link_libraries(asciisweeper PRIVATE ${CURSES_LIBRARIES} OpenSSL::SSL OpenSSL::Crypto)

add_executable(asciisweeper-server src/server.c ${COMMON_SRC})
target_include_directories(asciisweeper-server PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/generated)
target_link_libraries(asciisweeper-server PRIVATE OpenSSL::SSL OpenSSL::Crypto Threads::Threads)
